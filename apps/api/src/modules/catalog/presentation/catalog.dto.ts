import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const CODE = /^[a-z][a-z0-9_]{1,40}$/;
const FLOW_TYPES = ['APPOINTMENT_SLOT', 'TABLE_RESERVATION', 'SERVICE_REQUEST_WINDOW', 'TEST_ORDER_WITH_COLLECTION'] as const;

export class CreateCategoryDto {
  @IsString() @Matches(CODE, { message: 'code must be lowercase snake_case, 2-41 chars' }) code!: string;
  @trim() @IsString() @Length(1, 100) name!: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsIn(FLOW_TYPES) booking_flow_type?: (typeof FLOW_TYPES)[number];
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sort_order?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @trim() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sort_order?: number;
  /** Optimistic concurrency: reject if someone else changed the category since you loaded it. */
  @IsOptional() @IsInt() @Min(1) expected_version?: number;
}

export class CreateServiceTypeDto {
  @IsString() @Matches(CODE, { message: 'code must be lowercase snake_case, 2-41 chars' }) code!: string;
  @trim() @IsString() @Length(1, 100) name!: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsObject() attribute_schema?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sort_order?: number;
}

export class UpdateServiceTypeDto {
  @IsOptional() @trim() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sort_order?: number;
}

export class CreateProviderServiceDto {
  @IsUUID() service_type_id!: string;
  @trim() @IsString() @Length(1, 120) name!: string;
  @IsOptional() @trim() @IsString() @MaxLength(1000) description?: string;
  /** Integer minor units (paise). 20000 = ₹200.00. */
  @IsInt() @Min(0) price_minor!: number;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsInt() @Min(5) @Max(1440) duration_min!: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) buffer_min?: number;
  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
}

export class UpdateProviderServiceDto {
  @IsOptional() @trim() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @trim() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() @Min(0) price_minor?: number;
  @IsOptional() @IsInt() @Min(5) @Max(1440) duration_min?: number;
  @IsOptional() @IsInt() @Min(0) @Max(240) buffer_min?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
}

export class SetStaffSkillsDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) service_ids!: string[];
}
