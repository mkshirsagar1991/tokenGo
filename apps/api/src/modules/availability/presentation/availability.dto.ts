import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_OR_24 = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

export class WindowDto {
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @Matches(HHMM, { message: 'start must be HH:MM (00:00-23:59)' }) start!: string;
  @Matches(HHMM_OR_24, { message: 'end must be HH:MM or 24:00' }) end!: string;
}

export class SetHoursDto {
  @IsArray() @ArrayMaxSize(28) @ValidateNested({ each: true }) @Type(() => WindowDto) working!: WindowDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(28) @ValidateNested({ each: true }) @Type(() => WindowDto) breaks?: WindowDto[];
}

export class ExceptionDto {
  @IsIn(['CLOSED', 'OPEN']) kind!: 'CLOSED' | 'OPEN';
  @Matches(DATE, { message: 'start_date must be YYYY-MM-DD' }) start_date!: string;
  @IsOptional() @Matches(DATE, { message: 'end_date must be YYYY-MM-DD' }) end_date?: string;
  @IsOptional() @Matches(HHMM, { message: 'start must be HH:MM' }) start?: string;
  @IsOptional() @Matches(HHMM_OR_24, { message: 'end must be HH:MM or 24:00' }) end?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class BlockDto {
  @IsISO8601({ strict: true }) start_at!: string;
  @IsISO8601({ strict: true }) end_at!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class PolicyDto {
  @IsOptional() @IsIn([5, 10, 15, 20, 30, 60, null]) slot_granularity_min?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(10080) min_lead_time_min?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) max_advance_days?: number | null;
  @IsOptional() @IsInt() @Min(5) @Max(1440) response_deadline_min?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(720) check_in_window_min?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(240) no_show_grace_min?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(168) settlement_hold_hours?: number | null;
}

export class SlotsQueryDto {
  @IsUUID() location_id!: string;
  /** ONE service (the original form)... */
  @ValidateIf((o: SlotsQueryDto) => o.service_ids === undefined) @IsUUID() service_id?: string;
  /** ...or SEVERAL, comma-separated (a haircut + a facial): one visit, the times and prices added up. */
  @ValidateIf((o: SlotsQueryDto) => o.service_ids !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter(Boolean) : value))
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @IsUUID(undefined, { each: true })
  service_ids?: string[];
  @IsOptional() @Matches(DATE, { message: 'date must be YYYY-MM-DD' }) date?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(14) days?: number;
  @IsOptional() @IsUUID() resource_id?: string;
}
