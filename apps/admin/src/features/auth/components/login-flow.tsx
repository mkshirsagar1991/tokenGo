'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { CheckboxField, TextField } from '@/components/ui/form';
import { authCall } from '@/lib/client/bff';
import { problemMessage, type Problem } from '@/lib/problem';

type Step = 'credentials' | 'enroll' | 'verify' | 'recovery';

const REASONS: Record<string, { tone: 'info' | 'warn'; text: string }> = {
  idle: { tone: 'warn', text: 'You were signed out after a period of inactivity.' },
  expired: { tone: 'warn', text: 'Your session ended. Please sign in again.' },
  signed_out: { tone: 'info', text: 'You have been signed out.' },
};

function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/bff') && !next.includes('\\') ? next : '/';
}

export function LoginFlow({ reason, next }: { reason?: string; next?: string }) {
  const [step, setStep] = useState<Step>('credentials');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [enrol, setEnrol] = useState<{ secret_base32: string; otpauth_uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [stored, setStored] = useState(false);
  const submitting = useRef(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const notice = reason ? REASONS[reason] : undefined;

  function fail(p: Problem) {
    setProblem(p);
    if (p.code === 'MFA_TOKEN_INVALID') {
      setStep('credentials');
      setCode('');
      setEnrol(null);
    }
  }

  // Fetch the authenticator secret when the enrolment step opens.
  useEffect(() => {
    if (step !== 'enroll' || enrol) return;
    let cancelled = false;
    void authCall<{ secret_base32: string; otpauth_uri: string }>('mfa/enroll').then((r) => {
      if (cancelled) return;
      if (r.ok) setEnrol(r.data);
      else fail(r.problem);
    });
    return () => {
      cancelled = true;
    };
  }, [step, enrol]);

  useEffect(() => {
    if (step === 'verify' || (step === 'enroll' && enrol)) codeRef.current?.focus();
  }, [step, enrol, useRecovery]);

  async function run(fn: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const onCredentials = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await authCall<{ status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED' }>('login', { email: email.trim(), password });
      if (!r.ok) return fail(r.problem);
      setPassword('');
      setCode('');
      setEnrol(null);
      setStep(r.data.status === 'MFA_ENROLLMENT_REQUIRED' ? 'enroll' : 'verify');
    });
  };

  const onActivate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await authCall<{ recovery_codes?: string[] }>('mfa/activate', { code });
      if (!r.ok) return fail(r.problem);
      setRecoveryCodes(r.data.recovery_codes ?? []);
      setStep('recovery');
    });
  };

  const onVerify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await authCall('mfa/verify', useRecovery ? { recovery_code: recoveryInput.trim() } : { code });
      if (!r.ok) return fail(r.problem);
      window.location.assign(safeNext(next));
    });
  };

  const codeField = (
    <TextField
      ref={codeRef}
      label="6-digit code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      disabled={busy}
      className="text-center font-mono text-lg tracking-[0.4em]"
    />
  );

  return (
    <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
      <div className="mb-6 flex items-center gap-3">
        <Image src="/brand/icon.png" alt="" width={40} height={40} unoptimized className="h-10 w-10 rounded-xl" />
        <div>
          <h1 className="text-xl font-semibold text-fg">TokenGo Admin</h1>
          <p className="text-sm text-fg-subtle">Staff sign-in</p>
        </div>
      </div>

      {notice && step === 'credentials' ? <Alert tone={notice.tone} className="mb-4">{notice.text}</Alert> : null}
      {problem ? (
        <Alert tone="danger" className="mb-4" title={problemMessage(problem)}>
          {problem.requestId ? <span className="text-xs">Reference: {problem.requestId}</span> : null}
        </Alert>
      ) : null}

      {step === 'credentials' ? (
        <form onSubmit={onCredentials} className="flex flex-col gap-4" noValidate={false}>
          <TextField label="E-mail" type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <TextField label="Password" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
            Continue
          </Button>
          <p className="text-xs text-fg-subtle">Two-factor authentication is required for every staff account. Sessions end after a period of inactivity.</p>
        </form>
      ) : null}

      {step === 'enroll' ? (
        <form onSubmit={onActivate} className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-fg">Set up your authenticator app</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
            <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …).</li>
            <li>Scan this QR code, or enter the key by hand.</li>
            <li>Type the 6-digit code it shows to finish.</li>
          </ol>
          {enrol ? (
            <div className="flex flex-col items-center gap-3">
              <QrCode value={enrol.otpauth_uri} label="QR code for your authenticator app" />
              <div className="w-full rounded-lg bg-surface-2 p-3 text-center">
                <p className="text-xs text-fg-subtle">Can&apos;t scan? Enter this key (time-based, 6 digits, 30 seconds)</p>
                <code className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-1 font-mono text-sm text-fg" data-testid="totp-secret">
                  {(enrol.secret_base32.match(/.{1,4}/g) ?? []).map((g, i) => (
                    <span key={i} className="whitespace-nowrap">
                      {g}
                    </span>
                  ))}
                </code>
              </div>
            </div>
          ) : (
            <p className="text-sm text-fg-muted" role="status">Preparing your key…</p>
          )}
          {codeField}
          <Button type="submit" variant="primary" loading={busy} disabled={!enrol || code.length !== 6}>
            Verify and finish setup
          </Button>
        </form>
      ) : null}

      {step === 'verify' ? (
        <form onSubmit={onVerify} className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-fg">Two-factor verification</h2>
          {useRecovery ? (
            <TextField label="Recovery code" hint="One of the 8 single-use codes you were shown when you set up two-factor." autoComplete="off" spellCheck={false} required value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} disabled={busy} className="font-mono" />
          ) : (
            <>
              <p className="text-sm text-fg-muted">Enter the code from your authenticator app.</p>
              {codeField}
            </>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={useRecovery ? recoveryInput.trim().length < 10 : code.length !== 6}>
            Sign in
          </Button>
          <button type="button" className="text-sm text-brand-soft-fg underline-offset-2 hover:underline" onClick={() => { setUseRecovery((v) => !v); setProblem(null); }}>
            {useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
          </button>
        </form>
      ) : null}

      {step === 'recovery' ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-fg">Save your recovery codes</h2>
          <Alert tone="warn" title="Shown only once">
            Each code works one time if you lose your authenticator. Store them in a password manager or somewhere safe offline. They cannot be shown again.
          </Alert>
          <ul className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3 font-mono text-sm text-fg" aria-label="Recovery codes">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join('\n')).catch(() => undefined)}>
            Copy all codes
          </Button>
          <CheckboxField label="I have saved these recovery codes" checked={stored} onChange={(e) => setStored(e.target.checked)} />
          <Button variant="primary" disabled={!stored} onClick={() => window.location.assign(safeNext(next))}>
            Continue to the portal
          </Button>
        </div>
      ) : null}

      {step !== 'credentials' && step !== 'recovery' ? (
        <button type="button" className="mt-4 text-sm text-fg-subtle hover:text-fg" onClick={() => { setStep('credentials'); setProblem(null); setCode(''); setEnrol(null); }}>
          ← Start over
        </button>
      ) : null}
    </div>
  );
}
