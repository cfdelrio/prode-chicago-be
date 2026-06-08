"use strict";
// IMPORTANTE: este worker usa setInterval y necesita un proceso long-running
// (ECS, EC2 o similar). NO puede ejecutarse en AWS Lambda (stateless).
// En producción, si este proceso no está corriendo, las notificaciones de
// kickoff y second_half (schedulerService) nunca se envían.
// Las notificaciones pre-partido por SMS/push van por reminderCutoff.js (Lambda OK).
Object.defineProperty(exports, "__esModule", { value: true });
const schedulerService_1 = require("./schedulerService");
console.log('Starting notification worker...');
const POLL_INTERVAL = 60000;
async function runWorker() {
    console.log('Worker checking for pending jobs...');
    try {
        await schedulerService_1.schedulerService.processPendingJobs();
    }
    catch (error) {
        console.error('Worker error:', error);
    }
}
setInterval(runWorker, POLL_INTERVAL);
runWorker();
process.on('SIGTERM', () => {
    console.log('Worker shutting down...');
    process.exit(0);
});
//# sourceMappingURL=notificationWorker.js.map