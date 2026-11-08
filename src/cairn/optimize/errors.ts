// A data problem the audit can explain to the user without a stack trace. The CLI maps it to
// exit code 3 ("missing resource"), matching the existing missing-host-data behaviour.
export class DataError extends Error {}
