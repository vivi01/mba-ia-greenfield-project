import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString } from 'class-validator';

export class InitUploadDto {
  /** Original filename; its extension derives the storage key and default title. */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** Video MIME type; must belong to the supported allowlist. */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /**
   * Total file size in bytes. Must be a positive integer. The 10GB ceiling is
   * enforced in `VideosService` so it surfaces as `413 FILE_TOO_LARGE` (per the
   * Error Catalog) rather than a generic 400 validation error.
   */
  @IsInt()
  @IsPositive()
  size_bytes: number;

  /** Optional title; defaults to `filename` when omitted. */
  @IsOptional()
  @IsString()
  title?: string;
}
