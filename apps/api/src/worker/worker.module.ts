import { Module } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PaymentsModule } from '../modules/payments';
import { SettlementModule } from '../modules/settlement';
import { MaintenanceService } from './maintenance.service';
import { OutboxRunner } from './outbox.runner';

/** Same code base and image as the API; this entry point runs the background loops instead of HTTP. */
// PaymentsModule / SettlementModule are imported explicitly: the runner drives their sweepers, and AppModule does not re-export modules.
@Module({ imports: [AppModule, PaymentsModule, SettlementModule], providers: [MaintenanceService, OutboxRunner] })
export class WorkerModule {}
