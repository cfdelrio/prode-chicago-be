"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const schedulerService_1 = require("./schedulerService");
const planillasRoutes = require("../routes/planillas");
console.log('Starting notification worker...');
const POLL_INTERVAL = 60000;
async function runWorker() {
    console.log('Worker checking for pending jobs...');
    try {
        await planillasRoutes.autoClosePlanillasAtCutoff();
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