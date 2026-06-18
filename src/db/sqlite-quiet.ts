// Drops ONLY node:sqlite's one-time ExperimentalWarning so the CLI stays clean. This
// module is imported BEFORE `node:sqlite` (ESM evaluates imports in order), so the filter
// is installed before the module initializes and emits the warning. Every other warning
// passes through unchanged.

const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
  const isError = warning instanceof Error;
  const optionType = typeof rest[0] === "object" && rest[0] !== null ? (rest[0] as { type?: string }).type : rest[0];
  const type = isError ? warning.name : optionType;
  const text = isError ? warning.message : warning;
  if (type === "ExperimentalWarning" && typeof text === "string" && text.includes("SQLite")) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
