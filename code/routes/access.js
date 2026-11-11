const express = require('express');
const access = require('../services/access.service');

const router = express.Router();

const esFormulario = (req) => Boolean(req.is('application/x-www-form-urlencoded'));

router.post('/login', (req, res) => {
    const { key, next: siguiente } = req.body || {};
    const destino = access.destinoSeguro(siguiente);

    if (!access.esClave(key)) {
        if (esFormulario(req)) {
            res.status(401).render('access', { layout: false, siguiente: destino, error: true });
            return;
        }
        res.status(401).json({ error: 'Wrong access key', code: 'access_key_rejected' });
        return;
    }

    res.cookie(access.COOKIE, access.valorCookie(), access.opcionesCookie());
    if (esFormulario(req)) {
        res.redirect(303, destino);
        return;
    }
    res.status(204).end();
});

router.post('/logout', (req, res) => {
    res.clearCookie(access.COOKIE, { path: '/' });
    if (esFormulario(req)) {
        res.redirect(303, '/');
        return;
    }
    res.status(204).end();
});

module.exports = router;
