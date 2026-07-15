import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class JioPayCallbackDto {
  @IsOptional()
  @IsString()
  acqName?: string;

  @IsOptional()
  @IsString()
  aggregatorID?: string;

  @IsOptional()
  @IsString()
  TransmissionDateTime?: string;

  @IsOptional()
  @IsString()
  paymentInstId?: string;

  @IsOptional()
  @IsString()
  cardNetwork?: string;

  @IsOptional()
  @IsString()
  customerMobileNo?: string;

  @IsOptional()
  @IsString()
  customerEmailID?: string;

  @IsOptional()
  @IsString()
  paymentSubInstType?: string;

  @IsOptional()
  @IsString()
  paymentMode?: string;

  @IsOptional()
  @IsString()
  amount?: string;

  @IsOptional()
  @IsString()
  responseCode?: string;

  @IsOptional()
  @IsString()
  respDescription?: string;

  @IsOptional()
  @IsString()
  merchantId?: string;

  @IsOptional()
  @IsString()
  merchantTxnNo?: string;

  @IsOptional()
  @IsString()
  txnID?: string;

  @IsOptional()
  @IsString()
  paymentDateTime?: string;

  @IsOptional()
  @IsString()
  paymentID?: string;

  @IsOptional()
  @IsBoolean()
  oth_charge?: boolean;

  @IsOptional()
  @IsString()
  secureHash?: string;
}
