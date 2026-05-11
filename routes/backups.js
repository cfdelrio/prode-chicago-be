"use strict";

const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const backupService = require('../services/backupService');

const router = Router();

router.use(authMiddleware, requireAdmin);

// List app-level dumps stored in S3.
router.get('/', async (req, res) => {
    try {
        const items = await backupService.listBackups();
        res.json({ success: true, data: items });
    } catch (error) {
        console.error('[backups] list error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trigger a manual app-level dump (pg → S3).
router.post('/', async (req, res) => {
    try {
        const result = await backupService.exportDatabase({ trigger: 'manual' });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[backups] create error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate a short-lived presigned download URL for a backup object.
router.get('/download', async (req, res) => {
    try {
        const { key } = req.query;
        if (!key) return res.status(400).json({ success: false, error: 'key requerido' });
        const url = await backupService.getDownloadUrl(String(key));
        res.json({ success: true, data: { url, expires_in: 300 } });
    } catch (error) {
        console.error('[backups] download error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// List RDS snapshots (automated + manual).
router.get('/snapshots', async (req, res) => {
    try {
        const items = await backupService.listSnapshots();
        res.json({ success: true, data: items });
    } catch (error) {
        console.error('[backups] snapshots list error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trigger an RDS manual snapshot.
router.post('/snapshots', async (req, res) => {
    try {
        const result = await backupService.createSnapshot({ trigger: 'manual' });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[backups] snapshot create error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
