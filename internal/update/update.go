// Package update checks GitHub Releases for a newer version of the app.
// No self-update: the app isn't code-signed yet, so silently replacing the
// binary would fight SmartScreen/antivirus heuristics — we only notify and
// link to the release page.
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"imference-desktop-go/internal/types"
)

const latestReleaseURL = "https://api.github.com/repos/Publikey/imference-desktop/releases/latest"

var httpClient = &http.Client{Timeout: 10 * time.Second}

// Check fetches the latest GitHub release and compares it to current
// ("X.X.X", no leading v). current == "dev" short-circuits to "no update"
// so local builds never nag or hit the network.
func Check(ctx context.Context, current string) (types.UpdateInfo, error) {
	info := types.UpdateInfo{CurrentVersion: current}
	if current == "dev" || current == "" {
		return info, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latestReleaseURL, nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "imference-desktop/"+current)

	resp, err := httpClient.Do(req)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("github releases/latest: HTTP %d", resp.StatusCode)
	}

	var release struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return info, err
	}

	info.LatestVersion = strings.TrimPrefix(release.TagName, "v")
	info.URL = release.HTMLURL
	info.UpdateAvailable = newer(info.LatestVersion, current)
	return info, nil
}

// newer reports whether a > b, comparing dotted numeric segments
// ("0.2.10" > "0.2.9"). Non-numeric or missing segments count as 0, so a
// pre-release tag like "0.3.0-rc1" compares as "0.3.0" — good enough here.
func newer(a, b string) bool {
	as, bs := segments(a), segments(b)
	for i := 0; i < 3; i++ {
		if as[i] != bs[i] {
			return as[i] > bs[i]
		}
	}
	return false
}

func segments(v string) [3]int {
	var out [3]int
	v, _, _ = strings.Cut(v, "-")
	v, _, _ = strings.Cut(v, "+")
	for i, part := range strings.SplitN(v, ".", 3) {
		if i >= 3 {
			break
		}
		n, _ := strconv.Atoi(strings.TrimSpace(part))
		out[i] = n
	}
	return out
}
