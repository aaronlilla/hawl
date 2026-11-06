import canonicalize from "canonicalize";

/** RFC 8785 JSON Canonicalization Scheme, via the `canonicalize` package. */
export function jcs(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError("value is not JSON-serializable");
  return out;
}

/** JCS as UTF-8 bytes: the exact bytes that get signed and hashed. */
export function jcsBytes(value: unknown): Buffer {
  return Buffer.from(jcs(value), "utf8");
}
