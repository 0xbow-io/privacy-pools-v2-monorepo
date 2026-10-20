import { Module } from "@nestjs/common";
import { DustRescueConfigService } from "./config/dust-rescue-config.service";
import { FirestoreDustRescueJobStore } from "./jobs/firestore-job-store.service";
import { JOB_STORE } from "./jobs/job-store.interface";
import { DetectionService } from "./detection/detection.service";
import { ChainWriteService } from "./chain-write/chain-write.service";
import { SweepService } from "./sweep/sweep.service";
import { SweepController } from "./sweep/sweep.controller";
import { PubSubController } from "./pubsub/pubsub.controller";

@Module({
    controllers: [SweepController, PubSubController],
    providers: [
        DustRescueConfigService,
        DetectionService,
        ChainWriteService,
        SweepService,
        { provide: JOB_STORE, useClass: FirestoreDustRescueJobStore },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
