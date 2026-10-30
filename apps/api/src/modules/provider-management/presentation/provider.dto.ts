import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class RegisterProviderDto {
  @trim() @IsString() @Length(2, 120) display_name!: string;
  @IsOptional() @trim() @IsString() @MaxLength(2000) description?: string;
}

export class UpdateProviderDto {
  @IsOptional() @trim() @IsString() @Length(2, 120) display_name?: string;
  @IsOptional() @trim() @IsString() @MaxLength(2000) description?: string;
}

export class LocationDto {
  @trim() @IsString() @Length(1, 120) name!: string;
  @trim() @IsString() @Length(1, 200) address_line1!: string;
  @IsOptional() @trim() @IsString() @MaxLength(200) address_line2?: string;
  @trim() @IsString() @Length(1, 100) city!: string;
  @trim() @IsString() @Length(1, 100) state!: string;
  @trim() @IsString() @Matches(/^[A-Za-z0-9 -]{3,10}$/, { message: 'postal_code is invalid' }) postal_code!: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/, { message: 'country must be an ISO-3166 alpha-2 code' }) country?: string;
  @IsNumber({ maxDecimalPlaces: 7 }) @Min(-90) @Max(90) latitude!: number;
  @IsNumber({ maxDecimalPlaces: 7 }) @Min(-180) @Max(180) longitude!: number;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

export class UpdateLocationDto {
  @IsOptional() @trim() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) address_line1?: string;
  @IsOptional() @trim() @IsString() @MaxLength(200) address_line2?: string;
  @IsOptional() @trim() @IsString() @Length(1, 100) city?: string;
  @IsOptional() @trim() @IsString() @Length(1, 100) state?: string;
  @IsOptional() @trim() @IsString() @Matches(/^[A-Za-z0-9 -]{3,10}$/) postal_code?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 7 }) @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 7 }) @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}

export class CreateStaffDto {
  @IsUUID() location_id!: string;
  @trim() @IsString() @Length(1, 100) display_name!: string;
  @IsOptional() @IsIn(['MANAGER', 'STAFF']) staff_role?: 'MANAGER' | 'STAFF';
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class UpdateStaffDto {
  @IsOptional() @trim() @IsString() @Length(1, 100) display_name?: string;
  @IsOptional() @IsIn(['MANAGER', 'STAFF']) staff_role?: 'MANAGER' | 'STAFF';
}

export class StaffQueryDto {
  @IsOptional() @IsUUID() location_id?: string;
}

export class ReasonDto {
  @trim() @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
}

export class AdminProviderQueryDto {
  @IsOptional() @IsEnum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'])
  status?: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

  @IsOptional() @IsUUID() cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
