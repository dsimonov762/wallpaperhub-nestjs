import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In } from 'typeorm';
import type { Page, PageQuery, SortOrder } from '../util/pagination.js';
import { toPage } from '../util/pagination.js';
import { User } from './entities/user.entity.js';

@Injectable()
export class UserRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  findById(id: string): Promise<User | null> {
    return this.dataSource.getRepository(User).findOneBy({ id });
  }

  /** Which of the two unique fields are already used by a live (not deleted) user? Case-insensitive. */
  async findTaken(
    username: string,
    email: string,
  ): Promise<{ username: boolean; email: boolean }> {
    const rows = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .select(['u.username', 'u.email'])
      .where('lower(u.username) = lower(:username)', { username })
      .orWhere('lower(u.email) = lower(:email)', { email })
      .getMany();
    return {
      username: rows.some(
        (r) => r.username.toLowerCase() === username.toLowerCase(),
      ),
      email: rows.some((r) => r.email.toLowerCase() === email.toLowerCase()),
    };
  }

  async findPage(
    query: Pick<PageQuery, 'page' | 'size'>,
    sort: SortOrder,
  ): Promise<Page<User>> {
    const [items, total] = await this.dataSource
      .getRepository(User)
      .findAndCount({
        order: { [sort.field]: sort.direction.toUpperCase(), id: 'ASC' },
        skip: query.page * query.size,
        take: query.size,
      });
    return toPage(items, total, query);
  }

  /** `SELECT ... FOR UPDATE`: concurrent writers of the same row queue up (use inside a transaction). */
  lockById(manager: EntityManager, id: string): Promise<User | null> {
    return manager.findOne(User, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /** Live users among `ids` (deleted and unknown ids are simply absent). */
  findByIds(ids: string[]): Promise<User[]> {
    return ids.length === 0
      ? Promise.resolve([])
      : this.dataSource.getRepository(User).findBy({ id: In(ids) });
  }

  /**
   * Every user changed at or after `since`, INCLUDING soft-deleted ones, oldest change first, read in pages
   * of `pageSize` (keyset pagination on (updated_at, id): constant cost per page, no OFFSET).
   *
   * The cursor is carried as text straight from PostgreSQL: JavaScript dates only have millisecond precision,
   * PostgreSQL has microseconds, and a truncated cursor would send the same rows again forever.
   */
  async *streamUpdatedSince(
    since: Date,
    pageSize: number,
  ): AsyncGenerator<User> {
    let cursor: { ts: string; id: string } | undefined;
    for (;;) {
      const query = this.dataSource
        .getRepository(User)
        .createQueryBuilder('u')
        .withDeleted()
        .addSelect(
          `to_char(u.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          'cursor_ts',
        )
        .orderBy('u.updated_at', 'ASC')
        .addOrderBy('u.id', 'ASC')
        .limit(pageSize);
      if (cursor)
        query.where(
          '(u.updated_at, u.id) > (CAST(:ts AS timestamptz), CAST(:id AS uuid))',
          cursor,
        );
      else query.where('u.updated_at >= :since', { since });

      const { entities, raw } = await query.getRawAndEntities<{
        cursor_ts: string;
        u_id: string;
      }>();
      yield* entities;
      if (entities.length < pageSize) return;
      const last = raw[raw.length - 1]!;
      cursor = { ts: last.cursor_ts, id: last.u_id };
    }
  }
}
