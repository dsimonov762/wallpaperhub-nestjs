/** `google.protobuf.Timestamp` as it appears in JavaScript objects (proto-loader with `longs: String`). */
export interface ProtoTimestamp {
  seconds: string;
  nanos: number;
}

export const toTimestamp = (date: Date): ProtoTimestamp => {
  const ms = date.getTime();
  return {
    seconds: String(Math.floor(ms / 1000)),
    nanos: (ms % 1000) * 1_000_000,
  };
};

/** A missing timestamp means "from the beginning of time". */
export const fromTimestamp = (
  ts: { seconds?: string | number; nanos?: number } | null | undefined,
): Date =>
  new Date(
    Number(ts?.seconds ?? 0) * 1000 + Math.floor((ts?.nanos ?? 0) / 1_000_000),
  );
