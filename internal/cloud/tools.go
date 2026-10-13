package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"imference-desktop-go/internal/wallet"
	"imference-desktop-go/internal/x402"
)

// Editing tools in the cloud (imference API, docs/tools.md "API"):
//
//	POST /tools/{tool_id}           Bearer API key, credits
//	POST /ondemand/tools/{tool_id}  x402
//	body: multipart — one part per input file (part name = input name,
//	      repeated for multiple inputs) + "params" (JSON)
//	-> {"request_id", "kind": "tool", "tool_id", "credits"}
//
// The result comes back through the usual GET /status (or /ondemand/status):
// 404 while pending, 422 on failure, 200 with data.Outputs (every output) and
// data.Text (describe).

const (
	// toolUploadTimeout covers the multipart upload (videos up to 500 MB).
	toolUploadTimeout = 10 * time.Minute
	// toolPollBudget bounds the wait for a tool result. Tools take seconds;
	// generation tools queue with the model's normal generations.
	toolPollBudget = 30 * time.Minute
)

// ToolRequest is one cloud tool run.
type ToolRequest struct {
	ToolID string
	Files  map[string][]string // input name -> local file paths
	Params map[string]any
}

// ToolOutput is one result item.
type ToolOutput struct {
	URL    string `json:"url"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Format string `json:"format"`
	Text   string `json:"text"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Seed   any    `json:"seed"`
	// LocalPath is where the output was downloaded (empty for text-only).
	LocalPath string `json:"-"`
}

// ToolResult is a finished cloud tool run.
type ToolResult struct {
	RequestID string
	Credits   float64
	Outputs   []ToolOutput
	Text      string
}

// ToolError is a failed cloud tool run. Code is a tool error code when the
// server sent one (invalid_input, too_large, oom, …), else "cloud".
type ToolError struct {
	Code     string
	Message  string
	HTTP     int
	Terminal bool // the request will not succeed by polling longer
}

func (e *ToolError) Error() string { return e.Message }

type toolPostResponse struct {
	RequestID string  `json:"request_id"`
	Kind      string  `json:"kind"`
	ToolID    string  `json:"tool_id"`
	Credits   float64 `json:"credits"`
}

// toolStatusResponse is the tool flavor of /status. Field matching in
// encoding/json is case-insensitive, so "URL" and "url" both land.
type toolStatusResponse struct {
	Data struct {
		RequestID string       `json:"RequestID"`
		Kind      string       `json:"Kind"`
		URL       string       `json:"URL"`
		Format    string       `json:"Format"`
		Seed      any          `json:"Seed"`
		Outputs   []ToolOutput `json:"Outputs"`
		Text      string       `json:"Text"`
	} `json:"data"`
}

// buildToolMultipart encodes the inputs + params. Files are read fully: the
// x402 rail re-sends the same body after the 402 challenge.
func buildToolMultipart(files map[string][]string, params map[string]any) ([]byte, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		for _, p := range files[name] {
			data, err := os.ReadFile(p)
			if err != nil {
				return nil, "", fmt.Errorf("read input %s: %w", name, err)
			}
			h := make(textproto.MIMEHeader)
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`,
				escapeQuotes(name), escapeQuotes(filepath.Base(p))))
			ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(p)))
			if ct == "" {
				ct = "application/octet-stream"
			}
			h.Set("Content-Type", ct)
			part, err := w.CreatePart(h)
			if err != nil {
				return nil, "", err
			}
			if _, err := part.Write(data); err != nil {
				return nil, "", err
			}
		}
	}
	if params == nil {
		params = map[string]any{}
	}
	pj, err := json.Marshal(params)
	if err != nil {
		return nil, "", fmt.Errorf("encode params: %w", err)
	}
	if err := w.WriteField("params", string(pj)); err != nil {
		return nil, "", err
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), w.FormDataContentType(), nil
}

var quoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

func escapeQuotes(s string) string { return quoteEscaper.Replace(s) }

// RunTool uploads the inputs, waits for the result and downloads every output
// into destDir. rail "x402" pays with signer on /ondemand/tools; anything else
// uses the Bearer apiKey. onStage reports "uploading" / "queued" /
// "downloading"; onEnqueued gets the request id the moment it exists.
func (c *Client) RunTool(ctx context.Context, rail, apiKey string, signer *wallet.Wallet, req ToolRequest,
	destDir string, onEnqueued func(requestID string, credits float64), onStage func(stage string)) (*ToolResult, error) {
	stage := func(s string) {
		if onStage != nil {
			onStage(s)
		}
	}
	if req.ToolID == "" {
		return nil, &ToolError{Code: "invalid_input", Message: "tool id missing", Terminal: true}
	}
	body, ctype, err := buildToolMultipart(req.Files, req.Params)
	if err != nil {
		return nil, &ToolError{Code: "invalid_input", Message: err.Error(), Terminal: true}
	}
	c.bus.Info("cloud", "tool upload", map[string]any{"tool": req.ToolID, "rail": rail, "bytes": len(body)})
	stage("uploading")

	postCtx, cancel := context.WithTimeout(ctx, toolUploadTimeout)
	defer cancel()
	var resp *http.Response
	if rail == "x402" {
		if signer == nil {
			return nil, &ToolError{Code: "cloud", Message: "x402 mode selected but no wallet configured", Terminal: true}
		}
		xc := x402.New(signer)
		xc.HTTP = c.http
		xc.Logger = busAsLogger{bus: c.bus}
		r, _ := http.NewRequestWithContext(postCtx, http.MethodPost, c.base+"/ondemand/tools/"+url.PathEscape(req.ToolID), bytes.NewReader(body))
		r.Header.Set("Content-Type", ctype)
		r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
		resp, err = xc.Do(r)
		if err != nil {
			var funds *x402.InsufficientFundsError
			if errors.As(err, &funds) {
				return nil, &ToolError{Code: "cloud", Message: funds.Error(), Terminal: true}
			}
			return nil, &ToolError{Code: "cloud", Message: "POST /ondemand/tools: " + err.Error()}
		}
	} else {
		if apiKey == "" {
			return nil, &ToolError{Code: "cloud", Message: "Cloud API key not set", Terminal: true}
		}
		r, _ := http.NewRequestWithContext(postCtx, http.MethodPost, c.base+"/tools/"+url.PathEscape(req.ToolID), bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+apiKey)
		r.Header.Set("Content-Type", ctype)
		resp, err = c.http.Do(r)
		if err != nil {
			return nil, &ToolError{Code: "cloud", Message: "POST /tools: " + err.Error()}
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusAccepted {
		return nil, toolHTTPError(resp)
	}
	var posted toolPostResponse
	if err := json.NewDecoder(resp.Body).Decode(&posted); err != nil || posted.RequestID == "" {
		return nil, &ToolError{Code: "cloud", Message: "unreadable /tools response", Terminal: true}
	}
	c.bus.Info("cloud", "tool enqueued", map[string]any{"tool": req.ToolID, "request_id": posted.RequestID, "credits": posted.Credits})
	if onEnqueued != nil {
		onEnqueued(posted.RequestID, posted.Credits)
	}
	stage("queued")

	res, err := c.pollTool(ctx, rail, apiKey, posted.RequestID)
	if err != nil {
		return nil, err
	}
	res.Credits = posted.Credits
	stage("downloading")
	if err := c.downloadToolOutputs(ctx, res, destDir); err != nil {
		return nil, err
	}
	return res, nil
}

// toolHTTPError reads {"error": "...", "code": "..."} from a non-2xx answer.
func toolHTTPError(resp *http.Response) *ToolError {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(raw, &body)
	msg := body.Error
	if msg == "" {
		msg = strings.TrimSpace(string(raw))
	}
	if msg == "" {
		msg = http.StatusText(resp.StatusCode)
	}
	code := body.Code
	if code == "" {
		switch resp.StatusCode {
		case http.StatusBadRequest:
			code = "invalid_input"
		case http.StatusRequestEntityTooLarge:
			code = "too_large"
		default:
			code = "cloud"
		}
	}
	return &ToolError{Code: code, Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, msg), HTTP: resp.StatusCode, Terminal: true}
}

// pollTool waits for the request to finish (404 = pending).
func (c *Client) pollTool(ctx context.Context, rail, apiKey, requestID string) (*ToolResult, error) {
	pollCtx, cancel := context.WithTimeout(ctx, toolPollBudget)
	defer cancel()
	statusURL := c.base + "/status?request_id=" + url.QueryEscape(requestID)
	if rail == "x402" {
		statusURL = c.base + "/ondemand/status?request_id=" + url.QueryEscape(requestID)
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	started, eased := time.Now(), false
	for {
		res, done, err := c.fetchToolStatus(pollCtx, statusURL, rail, apiKey)
		if err != nil {
			return nil, err
		}
		if done {
			res.RequestID = requestID
			return res, nil
		}
		select {
		case <-pollCtx.Done():
			if ctx.Err() != nil {
				return nil, &ToolError{Code: "cancelled", Message: "cancelled", Terminal: true}
			}
			return nil, &ToolError{Code: "timeout", Message: "the cloud tool did not finish in time (request " + requestID + ")"}
		case <-ticker.C:
			eased = easeOffPolling(ticker, started, eased)
		}
	}
}

func (c *Client) fetchToolStatus(ctx context.Context, statusURL, rail, apiKey string) (*ToolResult, bool, error) {
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, statusURL, nil)
	if rail != "x402" {
		r.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := c.http.Do(r)
	if err != nil {
		return nil, false, nil // blip — keep polling (the loop's ctx bounds it)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		var parsed toolStatusResponse
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			return nil, false, &ToolError{Code: "cloud", Message: "unreadable /status answer: " + err.Error(), Terminal: true}
		}
		d := parsed.Data
		res := &ToolResult{Outputs: d.Outputs, Text: d.Text}
		if len(res.Outputs) == 0 && d.URL != "" {
			res.Outputs = []ToolOutput{{URL: d.URL, Format: d.Format, Seed: d.Seed}}
		}
		if len(res.Outputs) == 0 && d.Text != "" {
			res.Outputs = []ToolOutput{{Name: "text", Type: "text", Format: "txt", Text: d.Text}}
		}
		if len(res.Outputs) == 0 {
			return nil, false, &ToolError{Code: "internal", Message: "the cloud tool returned no output", Terminal: true}
		}
		return res, true, nil
	case resp.StatusCode == http.StatusNotFound:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, false, nil
	case transientStatus(resp.StatusCode):
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, false, nil
	default:
		te := toolHTTPError(resp)
		if te.Code == "invalid_input" && resp.StatusCode != http.StatusBadRequest {
			te.Code = "cloud"
		}
		if resp.StatusCode == http.StatusUnprocessableEntity && te.Code == "cloud" {
			te.Code = "internal" // the worker failed without a typed code
		}
		return nil, false, te
	}
}

// downloadToolOutputs fetches every URL output into destDir.
func (c *Client) downloadToolOutputs(ctx context.Context, res *ToolResult, destDir string) error {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return &ToolError{Code: "internal", Message: err.Error(), Terminal: true}
	}
	for i := range res.Outputs {
		o := &res.Outputs[i]
		if o.Type == "" {
			o.Type = "image"
		}
		if o.Name == "" {
			o.Name = o.Type
		}
		if o.Type == "text" && o.Text == "" && res.Text != "" {
			o.Text = res.Text
		}
		if o.URL == "" {
			continue
		}
		if o.Type == "text" && o.Text != "" {
			continue // inlined: no need to fetch the .txt blob
		}
		ext := ""
		if o.Format != "" {
			ext = "." + strings.TrimPrefix(strings.ToLower(o.Format), ".")
			if ext == ".jpeg" {
				ext = ".jpg"
			}
		}
		if ext == "" {
			if u, err := url.Parse(o.URL); err == nil {
				ext = strings.ToLower(filepath.Ext(u.Path))
			}
		}
		dest := filepath.Join(destDir, fmt.Sprintf("%s-%d%s", sanitizeName(o.Name), i, ext))
		if err := c.downloadFileWithRetry(ctx, o.URL, dest); err != nil {
			return &ToolError{Code: "cloud", Message: "download result: " + err.Error()}
		}
		if o.Type == "text" {
			if b, err := os.ReadFile(dest); err == nil {
				o.Text = string(b)
			}
		}
		o.LocalPath = dest
	}
	return nil
}

func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "output"
	}
	return b.String()
}

// downloadFileWithRetry streams src to dest (atomic rename), retrying
// transient failures like downloadWithRetry.
func (c *Client) downloadFileWithRetry(ctx context.Context, src, dest string) error {
	budgetCtx, cancel := context.WithTimeout(ctx, 3*downloadBudget)
	defer cancel()
	var lastErr error
	backoff := time.Second
	for attempt := 1; attempt <= downloadTries; attempt++ {
		err := c.downloadFile(budgetCtx, src, dest)
		if err == nil {
			return nil
		}
		lastErr = err
		if !isRetryableDownloadErr(err) || budgetCtx.Err() != nil || attempt == downloadTries {
			break
		}
		select {
		case <-time.After(backoff):
		case <-budgetCtx.Done():
			return budgetCtx.Err()
		}
		backoff *= 2
	}
	return lastErr
}

func (c *Client) downloadFile(ctx context.Context, src, dest string) error {
	r, _ := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	r.Header.Set("User-Agent", "imference-desktop-go")
	resp, err := c.http.Do(r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &httpStatusError{status: resp.StatusCode, snippet: string(snippet)}
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}
