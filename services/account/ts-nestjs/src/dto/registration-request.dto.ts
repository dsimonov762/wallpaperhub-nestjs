import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export const LOCALES = ['en', 'de', 'es'] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RegistrationRequestDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 64,
    pattern: '^[A-Za-z0-9_]+$',
    example: 'alice_01',
  })
  @Transform(trim)
  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9_]+$/)
  username!: string;

  @ApiProperty({ format: 'email', maxLength: 320 })
  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /** Deliberately NOT trimmed: spaces may be part of a password. */
  @ApiProperty({ minLength: 8, maxLength: 128, writeOnly: true })
  @IsString()
  @Length(8, 128)
  password!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  displayName!: string;

  @ApiPropertyOptional({
    enum: LOCALES,
    description:
      'Defaults to the language negotiated from Accept-Language, else en',
  })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: string;
}
