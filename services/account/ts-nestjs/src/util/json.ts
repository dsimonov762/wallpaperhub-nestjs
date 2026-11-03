/**
 * A JSON object stored in a jsonb column. `any` values (instead of `unknown`) keep
 * TypeORM's insert/update typings happy; the shape is validated where the data is built.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonObject = Record<string, any>;
