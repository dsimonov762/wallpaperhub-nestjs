import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE_SIZE } from '../util/pagination.js';

/** `?page=0&size=20&sort=createdAt,desc` (README 5.2). `size` is capped at 100. */
export class PageQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page: number = 0;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  size: number = 20;

  @ApiPropertyOptional({
    maxLength: 60,
    example: 'createdAt,desc',
    description: 'field,direction; the allowed fields depend on the endpoint',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  sort?: string;
}
