import { useId, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { explorerTx } from "@/lib/config";

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>
      {title && <h2 className="mb-3 text-lg font-semibold text-stone-900">{title}</h2>}
      {children}
    </section>
  );
}

export function Button({ className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-xl bg-emerald-700 px-4 py-2 font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    />
  );
}

export function GhostButton({ className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-xl border border-stone-300 px-4 py-2 font-medium text-stone-800 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    />
  );
}

/** Labelled input. `error` marks the field invalid and is linked to it for screen readers. */
export function Field({
  label,
  hint,
  error,
  id: idProp,
  ...p
}: { label: string; hint?: string; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="block text-sm">
      <label htmlFor={id} className="mb-1 block font-medium text-stone-700">
        {label}
      </label>
      <input
        {...p}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full rounded-xl border px-3 py-2 text-base text-stone-900 outline-none focus:ring-2 ${
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-100"
            : "border-stone-300 focus:border-emerald-600 focus:ring-emerald-100"
        }`}
      />
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-stone-500">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="mt-1 block text-xs text-red-700">
          {error}
        </span>
      )}
    </div>
  );
}

/** Errors are announced at once; everything else politely. */
export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const c = {
    info: "bg-sky-50 text-sky-900 border-sky-200",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    error: "bg-red-50 text-red-900 border-red-200",
    ok: "bg-emerald-50 text-emerald-900 border-emerald-200",
  }[tone];
  const role = tone === "error" ? "alert" : "status";
  return (
    <div role={role} aria-live={role === "alert" ? "assertive" : "polite"} className={`rounded-xl border px-4 py-3 text-sm ${c}`}>
      {children}
    </div>
  );
}

export function TxStatus({ error, sig, label = "Done." }: { error: string | null; sig: string | null; label?: string }) {
  if (error) return <Notice tone="error">{error}</Notice>;
  if (sig)
    return (
      <Notice tone="ok">
        {label}{" "}
        <a className="underline" href={explorerTx(sig)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      </Notice>
    );
  return null;
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-stone-50 p-4">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-stone-900">{value}</div>
      {sub && <div className="text-xs text-stone-500">{sub}</div>}
    </div>
  );
}

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-3xl font-bold text-stone-900">{title}</h1>
      {sub && <p className="mt-1 text-stone-600">{sub}</p>}
    </div>
  );
}
