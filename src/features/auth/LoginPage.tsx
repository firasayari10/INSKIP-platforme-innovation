import { ArrowLeft, ArrowRight, LoaderCircle, Mail, MailCheck } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  classifyAuthError,
  parseEmail,
  parseOtpCode,
  parsePassword,
  safeRedirectPath,
  secondsUntilResend,
} from "@/domain/auth";
import { authErrorMessages, emailErrorMessages, otpErrorMessages, passwordErrorMessages } from "@/lib/messages";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthProvider";

type Step =
  | { name: "password" }
  | { name: "signup" }
  | { name: "signup_sent"; email: string }
  | { name: "email" }
  | { name: "sent"; email: string; sentAt: number };

export function LoginPage() {
  const { state, client } = useAuth();
  const [params] = useSearchParams();
  const next = safeRedirectPath(params.get("next"));
  const [step, setStep] = useState<Step>(() => (params.get("mode") === "inscription" ? { name: "signup" } : { name: "password" }));

  if (state.status === "authenticated") return <Navigate to={next} replace />;

  const callbackUrl = () => {
    const redirect = new URL("/auth/callback", window.location.origin);
    redirect.searchParams.set("next", next);
    return redirect.toString();
  };

  const signInWithPassword = async (email: string, password: string): Promise<string | null> => {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (!error) return null; // AuthProvider publie la session, puis redirection vers `next`
    return authErrorMessages[classifyAuthError(error, "sign_in_password") ?? "unknown"];
  };

  const signUp = async (email: string, password: string): Promise<string | null> => {
    // Pré-contrôle pour un message clair ; la base refuse de toute façon un domaine non autorisé.
    const { data: allowed, error: checkError } = await client.rpc("signup_domain_allowed", { p_email: email });
    if (!checkError && allowed === false) return authErrorMessages.signup_domain_not_allowed;

    const { error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: callbackUrl() } });
    if (error) return authErrorMessages[classifyAuthError(error, "sign_up") ?? "unknown"];
    // Même écran si l'adresse a déjà un compte : on ne révèle pas qui est inscrit.
    setStep({ name: "signup_sent", email });
    return null;
  };

  const tabs = (step.name === "password" || step.name === "signup") && (
    <div role="tablist" aria-label="Connexion ou inscription" className="mb-8 grid grid-cols-2 rounded-lg bg-muted p-1 text-sm">
      {(
        [
          ["password", "Se connecter"],
          ["signup", "Créer un compte"],
        ] as const
      ).map(([name, label]) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={step.name === name}
          onClick={() => setStep(name === "signup" ? { name: "signup" } : { name: "password" })}
          className={
            step.name === name
              ? "rounded-md bg-background px-3 py-2 font-medium text-foreground shadow-sm"
              : "rounded-md px-3 py-2 text-muted-foreground hover:text-foreground"
          }
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (step.name === "password" || step.name === "signup" || step.name === "signup_sent") {
    return (
      <AuthLayout>
        {tabs}
        {step.name === "password" && (
          <PasswordForm mode="sign_in" onSubmit={signInWithPassword} onUseLink={() => setStep({ name: "email" })} />
        )}
        {step.name === "signup" && <PasswordForm mode="sign_up" onSubmit={signUp} />}
        {step.name === "signup_sent" && (
          <SignUpSent email={step.email} onBack={() => setStep({ name: "password" })} />
        )}
      </AuthLayout>
    );
  }

  const sendLink = async (email: string): Promise<string | null> => {
    // Toujours un paramètre `next` : le modèle d'e-mail y ajoute « &token_hash=… ».
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false, // un lien ne crée jamais de compte : inscription par le formulaire dédié
        emailRedirectTo: callbackUrl(),
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
        <EmailStep onSubmit={sendLink} onBack={() => setStep({ name: "password" })} />
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

function PasswordForm({
  mode,
  onSubmit,
  onUseLink,
}: {
  mode: "sign_in" | "sign_up";
  onSubmit: (email: string, password: string) => Promise<string | null>;
  onUseLink?: () => void;
}) {
  const id = useId();
  const signUp = mode === "sign_up";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setFormError(null);
    const parsedEmail = parseEmail(email);
    const next: typeof errors = {};
    if (!parsedEmail.ok) next.email = emailErrorMessages[parsedEmail.error];
    if (signUp) {
      const parsedPassword = parsePassword(password);
      if (!parsedPassword.ok) next.password = passwordErrorMessages[parsedPassword.error];
      else if (confirm !== password) next.confirm = "Les deux mots de passe ne sont pas identiques.";
    } else if (password.length === 0) {
      next.password = passwordErrorMessages.password_empty;
    }
    setErrors(next);
    if (!parsedEmail.ok || Object.keys(next).length > 0) return;
    setPending(true);
    const message = await onSubmit(parsedEmail.value, password);
    setPending(false);
    if (message) setFormError(message);
  };

  const field = (
    key: "email" | "password" | "confirm",
    label: string,
    props: { type: string; autoComplete: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean },
    hint?: string,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        type={props.type}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `${id}-${key}-error` : hint ? `${id}-${key}-hint` : undefined}
        disabled={pending}
        className="h-11"
      />
      {errors[key] ? (
        <p id={`${id}-${key}-error`} className="text-sm text-destructive">
          {errors[key]}
        </p>
      ) : (
        hint && (
          <p id={`${id}-${key}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">{signUp ? "Créer un compte" : "Connexion"}</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          {signUp
            ? "Réservé aux adresses professionnelles @inskip.fr. Un e-mail vous sera envoyé pour confirmer votre adresse."
            : "Saisissez votre adresse e-mail professionnelle et votre mot de passe."}
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {field("email", "Adresse e-mail", {
          type: "email",
          autoComplete: "email",
          autoFocus: true,
          placeholder: signUp ? "prenom.nom@inskip.fr" : "prenom.nom@entreprise.fr",
          value: email,
          onChange: setEmail,
        })}
        {field(
          "password",
          "Mot de passe",
          {
            type: "password",
            autoComplete: signUp ? "new-password" : "current-password",
            value: password,
            onChange: setPassword,
          },
          signUp ? "Au moins 10 caractères, avec des lettres et des chiffres." : undefined,
        )}
        {signUp &&
          field("confirm", "Confirmer le mot de passe", {
            type: "password",
            autoComplete: "new-password",
            value: confirm,
            onChange: setConfirm,
          })}

        {formError && <Alert tone="error">{formError}</Alert>}

        <Button type="submit" className="h-11 w-full" disabled={pending}>
          {pending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {signUp ? "Création du compte…" : "Connexion…"}
            </>
          ) : (
            <>
              {signUp ? "Créer mon compte" : "Se connecter"}
              <ArrowRight className="size-4" aria-hidden />
            </>
          )}
        </Button>
      </form>

      {onUseLink && (
        <div className="border-t pt-6 text-sm">
          <button
            type="button"
            onClick={onUseLink}
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <Mail className="size-4" aria-hidden />
            Recevoir plutôt un lien de connexion par e-mail
          </button>
          <p className="mt-1 text-xs text-muted-foreground">Pour les comptes invités, sans mot de passe.</p>
        </div>
      )}
    </div>
  );
}

function SignUpSent({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <div className="space-y-6">
      <span className="flex size-11 items-center justify-center rounded-xl bg-brand-navy text-brand-lime">
        <MailCheck className="size-5" aria-hidden />
      </span>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Confirmez votre adresse</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          Si l'adresse <span className="font-medium text-foreground break-all">{email}</span> peut être inscrite, un e-mail
          de confirmation vient de lui être envoyé. Cliquez sur le lien qu'il contient, puis connectez-vous avec votre mot de
          passe.
        </p>
      </div>
      <Button variant="outline" className="h-11 w-full" onClick={onBack}>
        <ArrowLeft className="size-4" aria-hidden />
        Retour à la connexion
      </Button>
      <p className="text-xs text-muted-foreground">Rien reçu après quelques minutes ? Vérifiez vos courriers indésirables.</p>
    </div>
  );
}

function EmailStep({ onSubmit, onBack }: { onSubmit: (email: string) => Promise<string | null>; onBack: () => void }) {
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
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Connexion par e-mail</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          Saisissez votre adresse e-mail professionnelle. Nous vous envoyons un lien et un code pour vous connecter,
          sans mot de passe.
        </p>
      </header>

      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div className="space-y-2">
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
            className="h-11"
          />
          {fieldError && (
            <p id={`${id}-email-error`} className="text-sm text-destructive">
              {fieldError}
            </p>
          )}
        </div>

        {formError && <Alert tone="error">{formError}</Alert>}

        <Button type="submit" className="h-11 w-full" disabled={pending}>
          {pending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Envoi en cours…
            </>
          ) : (
            <>
              Recevoir mon lien de connexion
              <ArrowRight className="size-4" aria-hidden />
            </>
          )}
        </Button>
      </form>

      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 border-t pt-6 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Se connecter avec un mot de passe
      </button>
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
    <div className="space-y-8">
      <header className="space-y-4">
        <span className="flex size-11 items-center justify-center rounded-xl bg-brand-navy text-brand-lime">
          <MailCheck className="size-5" aria-hidden />
        </span>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Vérifiez votre boîte mail</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            Si l'adresse <span className="font-medium text-foreground break-all">{email}</span> est autorisée, vous
            allez recevoir un e-mail. Cliquez sur le lien qu'il contient ou saisissez le code ci-dessous.
          </p>
        </div>
      </header>

      <form onSubmit={handleVerify} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor={`${id}-code`}>Code reçu par e-mail</Label>
          <Input
            id={`${id}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={14}
            placeholder="••••••••"
            value={code}
            onChange={e => setCode(e.target.value)}
            aria-invalid={error ? true : undefined}
            disabled={pending !== null}
            className="h-11 text-center font-mono text-lg tracking-[0.4em] placeholder:tracking-[0.4em]"
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}

        <Button type="submit" className="h-11 w-full" disabled={pending !== null}>
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

      <div className="flex flex-col gap-3 border-t pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onChangeEmail}
          className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Changer d'adresse
        </button>
        <button
          type="button"
          onClick={handleResend}
          disabled={wait > 0 || pending !== null}
          className="text-left font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:font-normal disabled:text-muted-foreground disabled:no-underline sm:text-right"
        >
          {pending === "resend"
            ? "Envoi…"
            : wait > 0
              ? `Renvoyer l'e-mail (${wait} s)`
              : "Renvoyer l'e-mail"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Rien reçu après quelques minutes ? Pensez à vérifier vos courriers indésirables.
      </p>
    </div>
  );
}
