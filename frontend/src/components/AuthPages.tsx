import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Code2,
  KeyRound,
  Loader2,
  LogOut,
  Radio,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { api } from "../lib";
import { useAuth, type User } from "../auth";
import { BRAND, Logo, TAGLINE } from "../brand";

type Nav = { navigate: (path: string) => void; notify: (message: string) => void };

// Only same-site relative paths are accepted as post-sign-in destinations.
export function nextPath(fallback = "/workspaces") {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

function AuthShell({
  title,
  subtitle,
  children,
  navigate,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  navigate: (path: string) => void;
}) {
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <a
          href="/"
          className="auth-logo"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <Logo />
        </a>
        <div>
          <h2>Code together. Share effortlessly.</h2>
          <ul>
            <li>
              <Radio size={16} /> Collaborate on code in real time
            </li>
            <li>
              <ShieldCheck size={16} /> Share secure, read-only links with anyone
            </li>
            <li>
              <KeyRound size={16} /> Access your workspaces from any device
            </li>
          </ul>
        </div>
        <small>{TAGLINE}</small>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <h1>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  // The hint is linked as a description, so the field's accessible name stays the label.
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? id + "-hint" : undefined} {...input} />
      {hint && (
        <small className="field-hint" id={id + "-hint"}>
          {hint}
        </small>
      )}
    </div>
  );
}

export function SignIn({ navigate }: Nav) {
  const { signedIn } = useAuth();
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; csrfToken: string }>(
        "/auth/signin",
        "POST",
        { email, password },
      );
      signedIn(result.user, result.csrfToken);
      navigate(nextPath());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to open your workspaces on any device."
      navigate={navigate}
    >
      <form onSubmit={submit} className="auth-form">
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          autoFocus
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="auth-row">
          <a
            href="/forgot-password"
            onClick={(e) => {
              e.preventDefault();
              navigate("/forgot-password");
            }}
          >
            Forgot password?
          </a>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full" disabled={busy}>
          {busy && <Loader2 size={16} className="spin" />} Sign In
        </button>
      </form>
      <p className="auth-switch">
        New to {BRAND}?{" "}
        <a
          href="/signup"
          onClick={(e) => {
            e.preventDefault();
            navigate("/signup" + location.search);
          }}
        >
          Create an account
        </a>
      </p>
    </AuthShell>
  );
}

export function SignUp({ navigate }: Nav) {
  const { signedIn } = useAuth();
  const [form, setForm] = useState({
      displayName: "",
      email: "",
      password: "",
      confirmPassword: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });
  const mismatch =
    !!form.confirmPassword && form.password !== form.confirmPassword;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; csrfToken: string }>(
        "/auth/signup",
        "POST",
        form,
      );
      signedIn(result.user, result.csrfToken);
      navigate(nextPath());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Create your account"
      subtitle="Own your workspaces and share read-only links with anyone."
      navigate={navigate}
    >
      <form onSubmit={submit} className="auth-form">
        <Field
          label="Display name"
          autoComplete="name"
          autoFocus
          required
          maxLength={60}
          value={form.displayName}
          onChange={set("displayName")}
          hint="Shown to collaborators and viewers while you edit."
        />
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={form.email}
          onChange={set("email")}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={form.password}
          onChange={set("password")}
          hint="At least 10 characters. Avoid common or personal words."
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          maxLength={128}
          value={form.confirmPassword}
          onChange={set("confirmPassword")}
          aria-invalid={mismatch}
        />
        {mismatch && <p className="field-error">The passwords do not match.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full" disabled={busy || mismatch}>
          {busy && <Loader2 size={16} className="spin" />} Create Account
        </button>
      </form>
      <p className="auth-switch">
        Already have an account?{" "}
        <a
          href="/signin"
          onClick={(e) => {
            e.preventDefault();
            navigate("/signin" + location.search);
          }}
        >
          Sign in
        </a>
      </p>
    </AuthShell>
  );
}

export function ForgotPassword({ navigate }: Nav) {
  return (
    <AuthShell
      title="Reset your password"
      subtitle={`Password resets are handled by your ${BRAND} administrator.`}
      navigate={navigate}
    >
      <div className="auth-notice">
        <p>
          This {BRAND} server does not send email yet. Contact your
          administrator and ask for a password reset link for your account
          email.
        </p>
        <p>
          The link works once and expires after 30 minutes. Never share it with
          anyone else.
        </p>
      </div>
      <button
        className="button secondary full"
        onClick={() => navigate("/signin")}
      >
        <ArrowLeft size={16} /> Back to sign in
      </button>
    </AuthShell>
  );
}

export function ResetPassword({ navigate, notify }: Nav) {
  const { signedIn } = useAuth();
  // The token arrives in the URL fragment, which browsers never send to the server.
  const [token] = useState(() => location.hash.slice(1));
  const [email, setEmail] = useState<string | null>(null),
    [error, setError] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    history.replaceState({}, "", "/reset-password");
    api<{ email: string }>("/auth/reset/" + encodeURIComponent(token))
      .then((value) => setEmail(value.email))
      .catch((err) => setError((err as Error).message));
  }, [token]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; csrfToken: string }>(
        "/auth/reset",
        "POST",
        { token, newPassword: password, confirmPassword: confirm },
      );
      signedIn(result.user, result.csrfToken);
      notify("Password updated");
      navigate("/workspaces");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Choose a new password"
      subtitle={email ? `For ${email}` : "Checking your reset link…"}
      navigate={navigate}
    >
      {email ? (
        <form onSubmit={submit} className="auth-form">
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={10}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            maxLength={128}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            disabled={busy || !password || password !== confirm}
          >
            Update password
          </button>
        </form>
      ) : (
        error && (
          <>
            <p className="error" role="alert">
              {error}
            </p>
            <button
              className="button secondary full"
              onClick={() => navigate("/signin")}
            >
              Back to sign in
            </button>
          </>
        )
      )}
    </AuthShell>
  );
}

export function AccountPage({ navigate, notify }: Nav) {
  const { user, update, signOut } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? ""),
    [email, setEmail] = useState(user?.email ?? ""),
    [emailPassword, setEmailPassword] = useState(""),
    [profileError, setProfileError] = useState(""),
    [passwords, setPasswords] = useState({
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    }),
    [passwordError, setPasswordError] = useState(""),
    [busy, setBusy] = useState("");
  if (!user) return null;
  const emailChanged = email.trim().toLowerCase() !== user.email.toLowerCase();
  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy("profile");
    setProfileError("");
    try {
      const result = await api<{ user: User }>("/account", "PATCH", {
        displayName,
        ...(emailChanged ? { email, currentPassword: emailPassword } : {}),
      });
      update(result.user);
      setEmailPassword("");
      notify("Profile updated");
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setBusy("password");
    setPasswordError("");
    try {
      await api("/auth/password", "POST", passwords);
      setPasswords({ currentPassword: "", newPassword: "", confirmPassword: "" });
      notify("Password changed. Other devices were signed out.");
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <main className="account-page">
      <div className="account-heading">
        <span className="account-avatar">
          <UserRound size={22} />
        </span>
        <div>
          <h1>Account</h1>
          <p>
            Signed in as <strong>{user.email}</strong> · member since{" "}
            {new Date(user.createdAt).toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
      </div>
      <section className="account-card">
        <h2>Profile</h2>
        <form onSubmit={saveProfile}>
          <Field
            label="Display name"
            required
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            hint="Collaborators and viewers see this name while you edit."
          />
          <Field
            label="Email address"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {emailChanged && (
            <Field
              label="Current password"
              type="password"
              autoComplete="current-password"
              required
              value={emailPassword}
              onChange={(e) => setEmailPassword(e.target.value)}
              hint="Required to change your email."
            />
          )}
          {profileError && (
            <p className="error" role="alert">
              {profileError}
            </p>
          )}
          <button className="button primary" disabled={busy === "profile"}>
            <Check size={16} /> Save profile
          </button>
        </form>
      </section>
      <section className="account-card">
        <h2>Password</h2>
        <form onSubmit={changePassword}>
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={passwords.currentPassword}
            onChange={(e) =>
              setPasswords({ ...passwords, currentPassword: e.target.value })
            }
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
            value={passwords.newPassword}
            onChange={(e) =>
              setPasswords({ ...passwords, newPassword: e.target.value })
            }
            hint="At least 10 characters. Changing it signs out your other devices."
          />
          <Field
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            maxLength={128}
            value={passwords.confirmPassword}
            onChange={(e) =>
              setPasswords({ ...passwords, confirmPassword: e.target.value })
            }
          />
          {passwordError && (
            <p className="error" role="alert">
              {passwordError}
            </p>
          )}
          <button
            className="button primary"
            disabled={
              busy === "password" ||
              passwords.newPassword !== passwords.confirmPassword
            }
          >
            <KeyRound size={16} /> Change password
          </button>
        </form>
      </section>
      <section className="account-card">
        <h2>Sessions</h2>
        <p className="muted">
          Signed in elsewhere, such as on a shared computer? Sign those
          devices out without affecting this one.
        </p>
        <div className="account-actions">
          <button
            className="button secondary"
            onClick={async () => {
              try {
                await api("/auth/signout-others", "POST", {});
                notify("Other devices signed out");
              } catch (err) {
                notify((err as Error).message);
              }
            }}
          >
            Sign out other devices
          </button>
          <button
            className="button secondary"
            onClick={async () => {
              await signOut();
              navigate("/");
            }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </section>
    </main>
  );
}

