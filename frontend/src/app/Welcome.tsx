// Welcome — the guided first run, desktop and web.
//
// Three steps in one dialog over the app:
//   1. What Imference does (create, edit, keep), with real catalog images.
//   2. The one decision that unblocks a first image:
//        desktop: where it runs (this computer's GPU or the cloud), with the
//                 GPU detected and a recommendation;
//        web:     how to pay (credits by card, or pay per image with USDC), or
//                 decide later at the first image.
//   3. The workspace (Engine / Create / Gallery, the shortcuts) and a first
//      prompt to start from.
// Shown once (localStorage "imference.welcome.v1"), on a fresh install only;
// the command palette reopens it ("Welcome tour").
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Brush,
  Check,
  Cloud,
  CornerDownLeft,
  Cpu,
  CreditCard,
  FolderDown,
  Images,
  Sparkles,
  Wallet,
  Wand2,
} from "lucide-react";
import logoUrl from "@/assets/logo.svg";
import { modLabel } from "@/components/CommandPalette";
import { Kbd } from "@/components/ds";
import { useEngineStatus } from "@/components/EnginePanel";
import { LocalEngineSection } from "@/components/LocalEngineSection";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/lib/target";
import type { ModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/wails-bridge";
import { openPayDialog, PACK_CREDITS, PACK_USD } from "@/lib/web-pay";
import type { Mode } from "./shared";

const STORAGE_KEY = "imference.welcome.v1";

export function welcomeDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "done";
  } catch {
    return true; // no storage: never nag
  }
}
function markWelcomeDone() {
  try {
    localStorage.setItem(STORAGE_KEY, "done");
  } catch {
    // storage unavailable: it shows again next time, harmless
  }
}

/** Sample prompts offered at the end, one per kind of result. */
const SAMPLE_PROMPTS = ["sample1", "sample2", "sample3"] as const;

export function Welcome({
  open,
  onOpenChange,
  mode,
  onModeChange,
  engineInstalled,
  onInstallDone,
  onOpenCloudSettings,
  onUsePrompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  engineInstalled: boolean;
  onInstallDone: () => void;
  /** Desktop: Settings → Cloud payment (after the tour closes). */
  onOpenCloudSettings: () => void;
  /** Fill the composer with a sample prompt and focus it. */
  onUsePrompt: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [count, setCount] = useState(0);
  // Desktop step 2: what the user picked (defaults to the recommendation).
  const [choice, setChoice] = useState<Mode | null>(null);
  const [afterClose, setAfterClose] = useState<null | (() => void)>(null);
  const { status: gpu } = useEngineStatus(open && !isWeb);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    void api
      .listCloudModels()
      .then((m) => {
        // One image per model family, for a varied deck (photo, anime, 3D…).
        const seen = new Set<string>();
        const picks = (m ?? []).filter((x) => {
          if (!x.image || x.modelType === "video" || seen.has(x.familyCode || x.modelCode)) return false;
          seen.add(x.familyCode || x.modelCode);
          return true;
        });
        setModels(picks.length >= 3 ? picks : (m ?? []).filter((x) => x.image && x.modelType !== "video"));
        setCount((m ?? []).length);
      })
      .catch(() => {});
  }, [open]);
  // Move focus to the step title, so a screen reader reads the new step.
  useEffect(() => {
    if (open) headingRef.current?.focus({ preventScroll: true });
  }, [step, open]);

  const goodGpu = !!gpu && gpu.vramGiB >= 6;
  const recommended: Mode = isWeb ? "cloud" : gpu ? (goodGpu ? "local" : "cloud") : mode;
  const picked = choice ?? recommended;
  const fan = useMemo(() => models.slice(0, 5), [models]);

  const close = (then?: () => void) => {
    markWelcomeDone();
    setAfterClose(() => then ?? null);
    onOpenChange(false);
  };
  const go = (n: number) => {
    setDir(n > step ? 1 : -1);
    setStep(n);
  };
  const steps = 3;

  // ---- step bodies -------------------------------------------------------
  const intro = (
    <>
      <p className="ds-eyebrow">{t("welcome.eyebrow")}</p>
      <h2 ref={headingRef} tabIndex={-1} className="welcome-title">
        {isWeb ? t("welcome.titleWeb") : t("welcome.titleDesktop")}
      </h2>
      <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">
        {count > 0
          ? t(isWeb ? "welcome.leadWeb" : "welcome.leadDesktop", { count })
          : t(isWeb ? "welcome.leadWebNoCount" : "welcome.leadDesktopNoCount")}
      </p>
      <ul className="mt-6 grid gap-3">
        <Feature icon={<Wand2 />} title={t("welcome.f1Title")} text={t("welcome.f1Text")} />
        <Feature icon={<Brush />} title={t("welcome.f2Title")} text={t("welcome.f2Text")} />
        <Feature
          icon={isWeb ? <FolderDown /> : <Images />}
          title={t("welcome.f3Title")}
          text={t(isWeb ? "welcome.f3TextWeb" : "welcome.f3TextDesktop")}
        />
      </ul>
    </>
  );

  const runWhere = (
    <>
      <p className="ds-eyebrow">{t("welcome.step2Eyebrow")}</p>
      <h2 ref={headingRef} tabIndex={-1} className="welcome-title">
        {t("welcome.whereTitle")}
      </h2>
      <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">{t("welcome.whereLead")}</p>
      <div role="radiogroup" aria-label={t("welcome.whereTitle")} className="mt-6 grid gap-3">
        <Choice
          on={picked === "local"}
          onSelect={() => setChoice("local")}
          icon={<Cpu />}
          title={t("welcome.localTitle")}
          badge={gpu && goodGpu ? t("welcome.recommended") : undefined}
          lines={[
            t("welcome.localPrice"),
            gpu
              ? gpu.gpuName
                ? t("welcome.gpuFound", { name: gpu.gpuName, vram: gpu.vramGiB.toFixed(0) })
                : t("welcome.gpuNone")
              : t("welcome.gpuChecking"),
          ]}
        />
        <Choice
          on={picked === "cloud"}
          onSelect={() => setChoice("cloud")}
          icon={<Cloud />}
          title={t("welcome.cloudTitle")}
          badge={gpu && !goodGpu ? t("welcome.recommended") : undefined}
          lines={[t("welcome.cloudPrice"), t("welcome.cloudNeeds")]}
        />
      </div>
      {picked === "local" && !engineInstalled && (
        <div className="mt-4 grid gap-2">
          <p className="text-muted-foreground text-xs">{t("welcome.localInstallNote")}</p>
          <LocalEngineSection onInstallDone={onInstallDone} />
        </div>
      )}
    </>
  );

  const howPay = (
    <>
      <p className="ds-eyebrow">{t("welcome.step2Eyebrow")}</p>
      <h2 ref={headingRef} tabIndex={-1} className="welcome-title">
        {t("welcome.payTitle")}
      </h2>
      <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">{t("welcome.payLead")}</p>
      <div className="mt-6 grid gap-3">
        <PayOption
          icon={<CreditCard />}
          title={t("welcome.creditsTitle")}
          text={t("welcome.creditsText", { credits: PACK_CREDITS.toLocaleString(), usd: PACK_USD })}
        />
        <PayOption icon={<Wallet />} title={t("welcome.walletTitle")} text={t("welcome.walletText")} />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {/* Ends the tour first: the payment window opens over the app, not
            behind this dialog. needs_key = the first choice (both ways). */}
        <Button variant="outline" onClick={() => close(() => void openPayDialog(isWeb ? "choose" : "needs_key"))}>
          {t("welcome.payNow")}
        </Button>
        <span className="text-muted-foreground text-xs">{t("welcome.payLater")}</span>
      </div>
    </>
  );

  const tour = (
    <>
      <p className="ds-eyebrow">{t("welcome.step3Eyebrow")}</p>
      <h2 ref={headingRef} tabIndex={-1} className="welcome-title">
        {t("welcome.tourTitle")}
      </h2>
      <div aria-hidden className="welcome-map mt-5">
        <span className="is-bar">{t(isWeb ? "welcome.mapBarWeb" : "welcome.mapBar")}</span>
        <span className="is-main">{t("panels.create")}</span>
        <span className="is-wide">{t("panels.gallery")}</span>
      </div>
      <ol className="mt-4 grid gap-2.5 text-sm">
        <TourItem n={1} text={t(isWeb ? "welcome.tour1Web" : "welcome.tour1Desktop")} />
        <TourItem n={2} text={t("welcome.tour2")} />
        <TourItem n={3} text={t("welcome.tour3")} />
      </ol>
      <div className="welcome-keys text-muted-foreground mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{modLabel}</Kbd>
          <Kbd>
            <CornerDownLeft className="size-3" />
          </Kbd>
          {t("welcome.keyGenerate")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{modLabel}</Kbd>
          <Kbd>K</Kbd>
          {t("welcome.keyCommands")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{modLabel}</Kbd>
          <Kbd>1–3</Kbd>
          {t("welcome.keyPanels")}
        </span>
      </div>
      <p className="ds-sublabel mt-6">{t("welcome.tryPrompt")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {SAMPLE_PROMPTS.map((k) => (
          <button
            key={k}
            type="button"
            className="welcome-prompt"
            onClick={() => close(() => onUsePrompt(t(`welcome.${k}`)))}
          >
            <Sparkles className="size-3.5 shrink-0" />
            <span>{t(`welcome.${k}`)}</span>
          </button>
        ))}
      </div>
    </>
  );

  const bodies = [intro, isWeb ? howPay : runWhere, tour];

  // The primary action of each step.
  const next = () => {
    if (step === 1 && !isWeb) onModeChange(picked);
    if (step < steps - 1) return go(step + 1);
    // Desktop, cloud chosen and not paid for yet: open the credits purchase.
    const needsCloudSetup = !isWeb && picked === "cloud";
    close(needsCloudSetup ? onOpenCloudSettings : () => document.getElementById("composer-prompt")?.focus());
  };
  const primaryLabel =
    step === 0
      ? t("welcome.start")
      : step === 1
        ? t("welcome.continue")
        : !isWeb && picked === "cloud"
          ? t("welcome.finishCloud")
          : t("welcome.finish");

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="welcome-overlay" />
        <DialogPrimitive.Content
          className="welcome"
          aria-describedby={undefined}
          // Focus the step title, not the first button: a screen reader starts
          // with what the dialog says, and no focus ring lands on "Skip".
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            headingRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            if (afterClose) {
              e.preventDefault();
              afterClose();
              setAfterClose(null);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">{t("welcome.dialogTitle")}</DialogPrimitive.Title>

          {/* Visual: the catalog itself, fanned on the brand stage. */}
          <div className="welcome-stage" aria-hidden>
            <div className="welcome-stage-glow" />
            <img src={logoUrl} alt="" className="welcome-logo" />
            <div className="welcome-fan" data-step={step}>
              {fan.length > 0
                ? fan.map((m, i) => (
                    <figure key={m.modelCode} className="welcome-card" data-front={i === 2 || undefined} style={{ "--i": i } as React.CSSProperties}>
                      <img src={m.image} alt="" loading="eager" />
                      <figcaption>{m.name}</figcaption>
                    </figure>
                  ))
                : [0, 1, 2].map((i) => <figure key={i} className="welcome-card is-ghost" style={{ "--i": i + 1 } as React.CSSProperties} />)}
            </div>
          </div>

          <div className="welcome-panel">
            <div className="welcome-body" key={step} data-dir={dir}>
              {bodies[step]}
            </div>

            <div className="welcome-footer">
              <div className="welcome-dots" role="img" aria-label={t("welcome.progress", { step: step + 1, total: steps })}>
                {Array.from({ length: steps }).map((_, i) => (
                  <span key={i} data-on={i === step || undefined} data-done={i < step || undefined} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                {step === 0 ? (
                  <Button variant="ghost" onClick={() => close()}>
                    {t("welcome.skip")}
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => go(step - 1)}>
                    <ArrowLeft />
                    {t("welcome.back")}
                  </Button>
                )}
                <Button variant="brand" size="lg" onClick={next} className="rounded-xl">
                  {primaryLabel}
                  {step < steps - 1 ? <ArrowRight /> : <Check />}
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="welcome-icon">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="text-muted-foreground block text-[13px] leading-snug">{text}</span>
      </span>
    </li>
  );
}

function Choice({
  on,
  onSelect,
  icon,
  title,
  badge,
  lines,
}: {
  on: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  badge?: string;
  lines: string[];
}) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onSelect} className="welcome-choice">
      <span className="welcome-icon">{icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {badge && <span className="welcome-badge">{badge}</span>}
        </span>
        {lines.map((l, i) => (
          <span key={i} className="text-muted-foreground block text-[13px] leading-snug">
            {l}
          </span>
        ))}
      </span>
      <span className="welcome-radio" aria-hidden>
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

function PayOption({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="ds-card flex items-start gap-3 p-3.5">
      <span className="welcome-icon">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="text-muted-foreground block text-[13px] leading-snug">{text}</span>
      </span>
    </div>
  );
}

function TourItem({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="welcome-step-n">{n}</span>
      <span className="text-muted-foreground leading-snug">{text}</span>
    </li>
  );
}

