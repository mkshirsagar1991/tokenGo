import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RequestOtpDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  device_id?: string;
}

export class VerifyOtpDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  device_id?: string;
}

export class RefreshDto {
  @IsString()
  @Length(20, 200)
  refresh_token!: string;
}
