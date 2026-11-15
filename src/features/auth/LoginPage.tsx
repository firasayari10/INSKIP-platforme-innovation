import { LoaderCircle } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { classifyAuthError, parseEmail, parseOtpCode, safeRedirectPath, secondsUntilResend } from "@/domain/auth";
import { authErrorMessages, emailErrorMessages, otpErrorMessages } from "@/lib/messages";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthProvider";

type Step = { name: "email" } | { name: "sent"; email: string; sentAt: number };

export function LoginPage() {
  const { state, client } = useAuth();
  const [params] = useSearchParams();
  const next = safeRedirectPath(params.get("next"));
  const [step, setStep] = useState<Step>({ name: "email" });

  if (state.status === "authenticated") return <Navigate to={next} replace />;

  const sendLink = async (email: string): Promise<string | null> => {
    const redirect = new URL("/auth/callback", window.location.origin);
    // Toujours un paramètre : le modèle d'e-mail y ajoute « &token_hash=… » (cf. README).
    redirect.searchParams.set("next", next);

    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false, // accès sur invitation uniquement
        emailRedirectTo: redirect.toString(),
      },
    });
    const code = error ? classifyAuthError(error, "send_link") : null;
    if (code) return authErrorMessages[code];
    setStep({ name: "sent", email, sentAt: Date.now() });
    return null;
  };

  return (
    <AuthLayout>
      {step.name === "email" ? (
        <EmailStep onSubmit={sendLink} />
      ) : (
        <CodeStep
          email={step.email}
          sentAt={step.sentAt}
          onResend={() => sendLink(step.email)}
          onChangeEmail={() => setStep({ name: "email" })}
        />
      )}
    </AuthLayout>
  );
}

function EmailStep({ onSubmit }: { onSubmit: (email: string) => Promise<string | null> }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setFormError(null);
    const parsed = parseEmail(value);
    if (!parsed.ok) {
      setFieldError(emailErrorMessages[parsed.error]);
      return;
    }
    setFieldError(null);
    setPending(true);
    const message = await onSubmit(parsed.value);
    setPending(false);
    if (message) setFormError(message);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Connexion</h1>
      <p className="text-sm text-muted-foreground">
        Saisissez votre adresse e-mail professionnelle. Vous recevrez un lien et un code de connexion ; aucun mot de
        passe n'est nécessaire.
      </p>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor={`${id}-email`}>Adresse e-mail</Label>
          <Input
            id={`${id}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            placeholder="prenom.nom@entreprise.fr"
            value={value}
            onChange={e => setValue(e.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-email-error` : undefined}
            disabled={pending}
            className="h-9"
          />
          {fieldError && (
            <p id={`${id}-email-error`} className="text-xs text-destructive">
              {fieldError}
            </p>
          )}
        </div>

        {formError && <Alert tone="error">{formError}</Alert>}

        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Envoi en cours…
            </>
          ) : (
            "Recevoir le lien de connexion"
          )}
        </Button>
      </form>
    </div>
  );
}

function CodeStep({
  email,
  sentAt,
  onResend,
  onChangeEmail,
}: {
  email: string;
  sentAt: number;
  onResend: () => Promise<string | null>;
  onChangeEmail: () => void;
}) {
  const id = useId();
  const { client } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState<"verify" | "resend" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const wait = secondsUntilResend(sentAt, now);
  useEffect(() => {
    if (wait === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [wait]);

  const handleVerify = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setInfo(null);
    const parsed = parseOtpCode(code);
    if (!parsed.ok) {
      setError(otpErrorMessages[parsed.error]);
      return;
    }
    setError(null);
    setPending("verify");
    const { error: authError } = await client.auth.verifyOtp({ email, token: parsed.value, type: "email" });
    setPending(null);
    if (authError) {
      setError(authErrorMessages[classifyAuthError(authError, "verify_code") ?? "unknown"]);
    }
    // En cas de succès, la session est publiée par AuthProvider et LoginPage redirige vers `next`.
  };

  const handleResend = async () => {
    if (pending || wait > 0) return;
    setError(null);
    setInfo(null);
    setPending("resend");
    const message = await onResend();
    setPending(null);
    if (message) setError(message);
    else {
      setNow(Date.now());
      setInfo("Un nouvel e-mail vient d'être envoyé.");
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Saisissez le code reçu</h1>
      <p className="text-sm text-muted-foreground">
        Si l'adresse <span className="font-semibold break-all text-foreground">{email}</span> est autorisée, un e-mail
        vient de lui être envoyé. Cliquez sur le lien qu'il contient ou saisissez le code ci-dessous.
      </p>

      <form onSubmit={handleVerify} noValidate className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor={`${id}-code`}>Code reçu par e-mail</Label>
          <Input
            id={`${id}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={14}
            value={code}
            onChange={e => setCode(e.target.value)}
            aria-invalid={error ? true : undefined}
            disabled={pending !== null}
            className="h-9 font-mono text-base tracking-[0.3em] md:text-base"
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}

        <Button type="submit" size="lg" className="w-full" disabled={pending !== null}>
          {pending === "verify" ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Vérification…
            </>
          ) : (
            "Se connecter"
          )}
        </Button>
      </form>

      <div className="flex justify-between gap-3 border-t border-border pt-3 text-ui">
        <Button type="button" variant="link" onClick={onChangeEmail}>
          Changer d'adresse
        </Button>
        <Button
          type="button"
          variant="link"
          onClick={handleResend}
          disabled={wait > 0 || pending !== null}
          className="disabled:text-muted-foreground disabled:no-underline disabled:opacity-100"
        >
          {pending === "resend"
            ? "Envoi…"
            : wait > 0
              ? `Renvoyer l'e-mail (${wait} s)`
              : "Renvoyer l'e-mail"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">Rien reçu après quelques minutes ? Vérifiez vos courriers indésirables.</p>
    </div>
  );
}
