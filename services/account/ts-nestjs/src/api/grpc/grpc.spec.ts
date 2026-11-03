import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toProtoUser } from '../../mapper/proto-user.mapper.js';
import { User } from '../../repository/entities/user.entity.js';
import { PROTO_PATH } from './setup-grpc.js';
import { fromTimestamp, toTimestamp } from './grpc-timestamp.js';

const user = (over: Partial<User> = {}): User =>
  Object.assign(new User(), {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    email: 'alice@example.com',
    displayName: 'Alice',
    locale: 'en',
    avatarAssetId: null,
    deletedAt: null,
    updatedAt: new Date('2026-10-25T10:00:00.250Z'),
    ...over,
  });
const ctx = { includeEmail: true, mediaBaseUrl: 'http://media.test/m' };

describe('timestamps', () => {
  it('round-trips with millisecond precision', () => {
    const date = new Date('2026-10-25T10:00:00.250Z');
    expect(toTimestamp(date)).toEqual({
      seconds: '1792922400',
      nanos: 250_000_000,
    });
    expect(fromTimestamp(toTimestamp(date)).getTime()).toBe(date.getTime());
  });

  it('treats a missing timestamp as the beginning of time', () => {
    expect(fromTimestamp(undefined).getTime()).toBe(0);
    expect(fromTimestamp({}).getTime()).toBe(0);
  });
});

describe('toProtoUser', () => {
  it('hides the email unless the caller may read it', () => {
    expect(toProtoUser(user(), ctx).email).toBe('alice@example.com');
    expect(toProtoUser(user(), { ...ctx, includeEmail: false }).email).toBe('');
  });

  it('builds the avatar url from the asset id, empty when there is none', () => {
    expect(toProtoUser(user(), ctx).avatarUrl).toBe('');
    expect(toProtoUser(user({ avatarAssetId: 'a b' }), ctx).avatarUrl).toBe(
      'http://media.test/m/a%20b',
    );
  });

  it('announces a deleted user without any personal data', () => {
    expect(toProtoUser(user({ deletedAt: new Date() }), ctx)).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      username: '',
      displayName: '',
      email: '',
      locale: '',
      avatarUrl: '',
      updatedAt: { seconds: '1792922400', nanos: 250_000_000 },
      deleted: true,
    });
  });
});

describe('proto file', () => {
  it('the service copy is identical to contracts/proto (run `pnpm contracts:sync` if this fails)', () => {
    const contract = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'contracts',
      'proto',
      'account',
      'v1',
      'account.proto',
    );
    expect(readFileSync(PROTO_PATH, 'utf8')).toBe(
      readFileSync(contract, 'utf8'),
    );
  });
});
