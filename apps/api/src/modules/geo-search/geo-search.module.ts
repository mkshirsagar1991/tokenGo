import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability';
import { IdentityAccessModule } from '../identity-access';
import { SearchService } from './application/search.service';
import { SearchRepository } from './infrastructure/search.repository';
import { SearchController } from './presentation/search.controller';

@Module({
  imports: [IdentityAccessModule, AvailabilityModule],
  controllers: [SearchController],
  providers: [SearchRepository, SearchService],
})
export class GeoSearchModule {}
