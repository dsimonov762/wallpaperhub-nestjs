import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export type UserStatus = 'ACTIVE' | 'SUSPENDED';

/** `users` table (README 6.1). The id is the Keycloak `sub`, so it is assigned, not generated. */
@Entity({ name: 'users' })
export class User {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  displayName!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  bio!: string | null;

  @Column({ type: 'varchar', length: 5, default: 'en' })
  locale!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  avatarAssetId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  bannerAssetId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status!: UserStatus;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Optimistic locking: TypeORM bumps it on every update (README 5.2: ETag / If-Match). */
  @VersionColumn()
  version!: number;
}
