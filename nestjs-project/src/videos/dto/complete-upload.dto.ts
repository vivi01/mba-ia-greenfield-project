import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

class CompletedPartDto {
  /** 1-based index of the uploaded part, as returned by storage. */
  @IsInt()
  @Min(1)
  part_number: number;

  /** ETag reported by storage for the uploaded part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** One entry per uploaded part, as returned by storage. Non-empty. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
