const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const unzipper = require('unzipper');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// Get database and services
const sqliteService = require('../services/sqlite.service');

// Configure multer for file upload
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Export version for compatibility checking
const EXPORT_VERSION = '1.0.0';

/**
 * Convert routes to XML format
 */
function routesToXml(data) {
    const escapeXml = (str) => {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    };

    const objectToXml = (obj, tagName) => {
        if (obj === null || obj === undefined) return `<${tagName}/>`;
        if (typeof obj !== 'object') return `<${tagName}>${escapeXml(obj)}</${tagName}>`;
        if (Array.isArray(obj)) {
            return obj.map(item => objectToXml(item, tagName.replace(/s$/, ''))).join('\n');
        }
        const content = Object.entries(obj)
            .map(([key, value]) => {
                if (Array.isArray(value)) {
                    return `<${key}>\n${value.map(item => objectToXml(item, key.replace(/s$/, ''))).join('\n')}\n</${key}>`;
                }
                return objectToXml(value, key);
            })
            .join('\n');
        return `<${tagName}>\n${content}\n</${tagName}>`;
    };

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<mockServerExport version="' + EXPORT_VERSION + '">\n';
    xml += '<metadata>\n';
    xml += `  <exportDate>${new Date().toISOString()}</exportDate>\n`;
    xml += `  <version>${EXPORT_VERSION}</version>\n`;
    xml += '</metadata>\n';

    // Routes
    xml += '<routes>\n';
    data.routes.forEach(route => {
        xml += '  <route>\n';
        Object.entries(route).forEach(([key, value]) => {
            if (key === 'conditions' && Array.isArray(value) && value.length > 0) {
                xml += '    <conditions>\n';
                value.forEach(cond => {
                    xml += '      <condition>\n';
                    Object.entries(cond).forEach(([ck, cv]) => {
                        xml += `        <${ck}>${escapeXml(cv)}</${ck}>\n`;
                    });
                    xml += '      </condition>\n';
                });
                xml += '    </conditions>\n';
            } else if (key === 'fallbacks' && Array.isArray(value) && value.length > 0) {
                xml += '    <fallbacks>\n';
                value.forEach(fb => {
                    xml += '      <fallback>\n';
                    Object.entries(fb).forEach(([fk, fv]) => {
                        // Handle nested conditions within fallback
                        if (fk === 'conditions' && Array.isArray(fv) && fv.length > 0) {
                            xml += '        <conditions>\n';
                            fv.forEach(cond => {
                                xml += '          <condition>\n';
                                Object.entries(cond).forEach(([ck, cv]) => {
                                    xml += `            <${ck}>${escapeXml(cv)}</${ck}>\n`;
                                });
                                xml += '          </condition>\n';
                            });
                            xml += '        </conditions>\n';
                        } else if (fv !== null && fv !== undefined) {
                            xml += `        <${fk}>${escapeXml(fv)}</${fk}>\n`;
                        }
                    });
                    xml += '      </fallback>\n';
                });
                xml += '    </fallbacks>\n';
            } else if (value !== null && value !== undefined) {
                xml += `    <${key}>${escapeXml(value)}</${key}>\n`;
            }
        });
        xml += '  </route>\n';
    });
    xml += '</routes>\n';

    // Tags
    xml += '<tags>\n';
    data.tags.forEach(tag => {
        xml += '  <tag>\n';
        Object.entries(tag).forEach(([key, value]) => {
            xml += `    <${key}>${escapeXml(value)}</${key}>\n`;
        });
        xml += '  </tag>\n';
    });
    xml += '</tags>\n';

    // Files manifest
    if (data.files && data.files.length > 0) {
        xml += '<files>\n';
        data.files.forEach(file => {
            xml += '  <file>\n';
            Object.entries(file).forEach(([key, value]) => {
                xml += `    <${key}>${escapeXml(value)}</${key}>\n`;
            });
            xml += '  </file>\n';
        });
        xml += '</files>\n';
    }

    xml += '</mockServerExport>';
    return xml;
}

/**
 * Parse XML to data object
 */
function xmlToRoutes(xmlContent) {
    // Simple XML parser for our specific format
    const getTagContent = (xml, tag) => {
        const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
        const matches = [];
        let match;
        while ((match = regex.exec(xml)) !== null) {
            matches.push(match[1].trim());
        }
        return matches;
    };

    const parseRoute = (routeXml) => {
        const route = {};
        const simpleFields = ['id', 'tipo', 'ruta', 'codigo', 'tiporespuesta', 'respuesta', 'esperaActiva',
            'isRegex', 'customHeaders', 'activo', 'orden', 'fileName', 'filePath', 'fileMimeType',
            'tags', 'operationId', 'summary', 'description', 'requestBodyExample'];

        simpleFields.forEach(field => {
            const match = routeXml.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
            if (match) {
                let value = match[1].trim()
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&amp;/g, '&');
                // Convert numeric fields
                if (['esperaActiva', 'isRegex', 'activo', 'orden'].includes(field)) {
                    value = parseInt(value) || 0;
                }
                route[field] = value;
            }
        });

        // Parse conditions
        const conditionsMatch = routeXml.match(/<conditions>([\s\S]*?)<\/conditions>/);
        if (conditionsMatch) {
            const conditionXmls = getTagContent(conditionsMatch[1], 'condition');
            route.conditions = conditionXmls.map(condXml => {
                const cond = {};
                const condFields = ['id', 'orden', 'nombre', 'criteria', 'codigo', 'tiporespuesta', 'respuesta', 'customHeaders', 'activo'];
                condFields.forEach(field => {
                    const match = condXml.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
                    if (match) {
                        let value = match[1].trim()
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&apos;/g, "'")
                            .replace(/&amp;/g, '&');
                        if (['orden', 'activo'].includes(field)) {
                            value = parseInt(value) || 0;
                        }
                        cond[field] = value;
                    }
                });
                return cond;
            });
        }

        // Parse fallbacks (for proxy routes)
        const fallbacksMatch = routeXml.match(/<fallbacks>([\s\S]*?)<\/fallbacks>/);
        if (fallbacksMatch) {
            const fallbackXmls = getTagContent(fallbacksMatch[1], 'fallback');
            route.fallbacks = fallbackXmls.map(fbXml => {
                const fb = {};
                const fbFields = ['id', 'orden', 'nombre', 'path_pattern', 'error_types', 'codigo', 'tiporespuesta', 'respuesta', 'customHeaders', 'activo'];
                fbFields.forEach(field => {
                    const match = fbXml.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
                    if (match) {
                        let value = match[1].trim()
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&apos;/g, "'")
                            .replace(/&amp;/g, '&');
                        if (['orden', 'activo'].includes(field)) {
                            value = parseInt(value) || 0;
                        }
                        fb[field] = value;
                    }
                });

                // Parse conditions within this fallback
                const fbConditionsMatch = fbXml.match(/<conditions>([\s\S]*?)<\/conditions>/);
                if (fbConditionsMatch) {
                    const conditionXmls = getTagContent(fbConditionsMatch[1], 'condition');
                    fb.conditions = conditionXmls.map(condXml => {
                        const cond = {};
                        const condFields = ['id', 'orden', 'nombre', 'criteria', 'codigo', 'tiporespuesta', 'respuesta', 'customHeaders', 'activo'];
                        condFields.forEach(field => {
                            const match = condXml.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
                            if (match) {
                                let value = match[1].trim()
                                    .replace(/&lt;/g, '<')
                                    .replace(/&gt;/g, '>')
                                    .replace(/&quot;/g, '"')
                                    .replace(/&apos;/g, "'")
                                    .replace(/&amp;/g, '&');
                                if (['orden', 'activo'].includes(field)) {
                                    value = parseInt(value) || 0;
                                }
                                cond[field] = value;
                            }
                        });
                        return cond;
                    });
                }

                return fb;
            });
        }

        return route;
    };

    const parseTag = (tagXml) => {
        const tag = {};
        ['id', 'name', 'color'].forEach(field => {
            const match = tagXml.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
            if (match) {
                tag[field] = match[1].trim()
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&amp;/g, '&');
            }
        });
        return tag;
    };

    const parseFile = (fileXml) => {
        const file = {};
        ['originalName', 'storedName', 'mimeType', 'routeId'].forEach(field => {
            const match = fileXml.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
            if (match) {
                file[field] = match[1].trim()
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&amp;/g, '&');
            }
        });
        return file;
    };

    // Parse routes
    const routesSection = xmlContent.match(/<routes>([\s\S]*?)<\/routes>/);
    const routes = routesSection ? getTagContent(routesSection[1], 'route').map(parseRoute) : [];

    // Parse tags
    const tagsSection = xmlContent.match(/<tags>([\s\S]*?)<\/tags>/);
    const tags = tagsSection ? getTagContent(tagsSection[1], 'tag').map(parseTag) : [];

    // Parse files
    const filesSection = xmlContent.match(/<files>([\s\S]*?)<\/files>/);
    const files = filesSection ? getTagContent(filesSection[1], 'file').map(parseFile) : [];

    return { routes, tags, files };
}

/**
 * GET /api/export
 * Export routes, tags, conditions, and optionally files
 */
router.get('/export', async (req, res) => {
    try {
        const format = req.query.format || 'json'; // 'json' or 'xml'
        const includeFiles = req.query.includeFiles === 'true';

        const db = sqliteService.getDatabase();

        // Get all routes
        const routes = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM rutas ORDER BY orden ASC', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Get conditional responses for each route
        for (const route of routes) {
            const conditions = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM conditional_responses WHERE route_id = ? ORDER BY orden ASC', [route.id], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
            route.conditions = conditions;

            // Get proxy fallbacks for proxy routes
            if (route.tiporespuesta === 'proxy') {
                const fallbacks = await new Promise((resolve, reject) => {
                    db.all('SELECT * FROM proxy_fallbacks WHERE route_id = ? ORDER BY orden ASC', [route.id], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    });
                });

                // Get conditions for each fallback
                for (const fallback of fallbacks) {
                    const fallbackConditions = await new Promise((resolve, reject) => {
                        db.all('SELECT * FROM proxy_fallback_conditions WHERE fallback_id = ? ORDER BY orden ASC', [fallback.id], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
                        });
                    });
                    fallback.conditions = fallbackConditions;
                }

                route.fallbacks = fallbacks;
            }
        }

        // Get all tags
        const tags = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM tags', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Prepare export data
        const exportData = {
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
            routes: routes,
            tags: tags,
            files: []
        };

        // Get files manifest if including files
        const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
        if (includeFiles && fs.existsSync(uploadsDir)) {
            routes.forEach(route => {
                if (route.filePath && route.fileName) {
                    const fullPath = path.join(__dirname, '..', route.filePath);
                    if (fs.existsSync(fullPath)) {
                        exportData.files.push({
                            originalName: route.fileName,
                            storedName: path.basename(route.filePath),
                            mimeType: route.fileMimeType,
                            routeId: route.id
                        });
                    }
                }
            });
        }

        // Create zip archive
        const archive = archiver('zip', { zlib: { level: 9 } });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="mock-server-export-${Date.now()}.zip"`);

        archive.pipe(res);

        // Add data file (JSON or XML)
        if (format === 'xml') {
            const xmlContent = routesToXml(exportData);
            archive.append(xmlContent, { name: 'data.xml' });
        } else {
            archive.append(JSON.stringify(exportData, null, 2), { name: 'data.json' });
        }

        // Add manifest file
        const manifest = {
            version: EXPORT_VERSION,
            format: format,
            exportDate: exportData.exportDate,
            routesCount: routes.length,
            tagsCount: tags.length,
            filesIncluded: includeFiles,
            filesCount: exportData.files.length
        };
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

        // Add files if requested
        if (includeFiles && exportData.files.length > 0) {
            exportData.files.forEach(file => {
                const route = routes.find(r => r.id === file.routeId);
                if (route && route.filePath) {
                    const fullPath = path.join(__dirname, '..', route.filePath);
                    if (fs.existsSync(fullPath)) {
                        archive.file(fullPath, { name: `uploads/${file.storedName}` });
                    }
                }
            });
        }

        await archive.finalize();

    } catch (error) {
        console.error('[EXPORT] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/import
 * Import routes, tags, conditions, and files from zip
 */
router.post('/import', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const conflictStrategy = req.body.conflictStrategy || 'skip'; // 'skip', 'overwrite', 'duplicate'
        const importFiles = req.body.importFiles === 'true';

        const db = sqliteService.getDatabase();
        const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');

        // Ensure uploads directory exists
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        // Extract zip contents
        const zipBuffer = req.file.buffer;
        const directory = await unzipper.Open.buffer(zipBuffer);

        // Find and parse manifest
        const manifestFile = directory.files.find(f => f.path === 'manifest.json');
        if (!manifestFile) {
            return res.status(400).json({ error: 'Invalid export file: manifest.json not found' });
        }
        const manifestContent = await manifestFile.buffer();
        const manifest = JSON.parse(manifestContent.toString());

        // Find and parse data file
        const dataFileName = manifest.format === 'xml' ? 'data.xml' : 'data.json';
        const dataFile = directory.files.find(f => f.path === dataFileName);
        if (!dataFile) {
            return res.status(400).json({ error: `Invalid export file: ${dataFileName} not found` });
        }
        const dataContent = await dataFile.buffer();

        let importData;
        if (manifest.format === 'xml') {
            importData = xmlToRoutes(dataContent.toString());
        } else {
            importData = JSON.parse(dataContent.toString());
        }

        const results = {
            routes: { imported: 0, skipped: 0, updated: 0 },
            tags: { imported: 0, skipped: 0 },
            conditions: { imported: 0 },
            files: { imported: 0, skipped: 0 }
        };

        // Map old route IDs to new ones
        const routeIdMap = {};

        // Import tags first
        for (const tag of (importData.tags || [])) {
            const existing = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM tags WHERE name = ? COLLATE NOCASE', [tag.name], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (existing) {
                results.tags.skipped++;
            } else {
                const newId = tag.id || uuidv4();
                await new Promise((resolve, reject) => {
                    db.run('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)',
                        [newId, tag.name, tag.color || '#6366f1'],
                        function(err) {
                            if (err) reject(err);
                            else resolve();
                        });
                });
                results.tags.imported++;
            }
        }

        // Get max order
        let maxOrder = await new Promise((resolve, reject) => {
            db.get('SELECT MAX(orden) as maxOrder FROM rutas', [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.maxOrder || 0);
            });
        });

        // Import routes
        for (const route of (importData.routes || [])) {
            const oldId = route.id;

            // Check for existing route with same path and method
            const existing = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM rutas WHERE ruta = ? AND tipo = ?', [route.ruta, route.tipo], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            let newRouteId;

            if (existing) {
                if (conflictStrategy === 'skip') {
                    results.routes.skipped++;
                    routeIdMap[oldId] = existing.id;
                    continue;
                } else if (conflictStrategy === 'overwrite') {
                    // Update existing route
                    await new Promise((resolve, reject) => {
                        db.run(`UPDATE rutas SET codigo = ?, respuesta = ?, tiporespuesta = ?, esperaActiva = ?,
                            isRegex = ?, customHeaders = ?, activo = ?, fileName = ?, filePath = ?,
                            fileMimeType = ?, tags = ?, operationId = ?, summary = ?, description = ?, requestBodyExample = ?
                            WHERE id = ?`,
                            [route.codigo, route.respuesta, route.tiporespuesta, route.esperaActiva || 0,
                            route.isRegex || 0, route.customHeaders, route.activo ?? 1, null, null,
                            null, route.tags, route.operationId, route.summary, route.description, route.requestBodyExample, existing.id],
                            function(err) {
                                if (err) reject(err);
                                else resolve();
                            });
                    });

                    // Delete old conditions
                    await new Promise((resolve, reject) => {
                        db.run('DELETE FROM conditional_responses WHERE route_id = ?', [existing.id], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });

                    // Delete old fallbacks
                    await new Promise((resolve, reject) => {
                        db.run('DELETE FROM proxy_fallbacks WHERE route_id = ?', [existing.id], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });

                    newRouteId = existing.id;
                    results.routes.updated++;
                } else {
                    // Duplicate - create new route with modified path
                    maxOrder++;
                    const newRuta = route.ruta + '_imported_' + Date.now();
                    await new Promise((resolve, reject) => {
                        db.run(`INSERT INTO rutas (tipo, ruta, codigo, tiporespuesta, respuesta, esperaActiva,
                            isRegex, customHeaders, activo, orden, tags, operationId, summary, description, requestBodyExample)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [route.tipo, newRuta, route.codigo, route.tiporespuesta, route.respuesta,
                            route.esperaActiva || 0, route.isRegex || 0, route.customHeaders, route.activo ?? 1,
                            maxOrder, route.tags, route.operationId, route.summary, route.description, route.requestBodyExample],
                            function(err) {
                                if (err) reject(err);
                                else {
                                    newRouteId = this.lastID;
                                    resolve();
                                }
                            });
                    });
                    results.routes.imported++;
                }
            } else {
                // Insert new route
                maxOrder++;
                await new Promise((resolve, reject) => {
                    db.run(`INSERT INTO rutas (tipo, ruta, codigo, tiporespuesta, respuesta, esperaActiva,
                        isRegex, customHeaders, activo, orden, tags, operationId, summary, description, requestBodyExample)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [route.tipo, route.ruta, route.codigo, route.tiporespuesta, route.respuesta,
                        route.esperaActiva || 0, route.isRegex || 0, route.customHeaders, route.activo ?? 1,
                        maxOrder, route.tags, route.operationId, route.summary, route.description, route.requestBodyExample],
                        function(err) {
                            if (err) reject(err);
                            else {
                                newRouteId = this.lastID;
                                resolve();
                            }
                        });
                });
                results.routes.imported++;
            }

            routeIdMap[oldId] = newRouteId;

            // Import conditions for this route
            if (route.conditions && route.conditions.length > 0 && newRouteId) {
                for (const cond of route.conditions) {
                    await new Promise((resolve, reject) => {
                        db.run(`INSERT INTO conditional_responses (route_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [newRouteId, cond.orden || 0, cond.nombre, cond.criteria, cond.codigo,
                            cond.tiporespuesta, cond.respuesta, cond.customHeaders, cond.activo ?? 1],
                            function(err) {
                                if (err) reject(err);
                                else resolve();
                            });
                    });
                    results.conditions.imported++;
                }
            }

            // Import fallbacks for proxy routes
            if (route.fallbacks && route.fallbacks.length > 0 && newRouteId) {
                for (const fb of route.fallbacks) {
                    // Ensure error_types is stored as JSON string
                    const errorTypes = typeof fb.error_types === 'string' ? fb.error_types : JSON.stringify(fb.error_types || ['all']);
                    const newFallbackId = await new Promise((resolve, reject) => {
                        db.run(`INSERT INTO proxy_fallbacks (route_id, orden, nombre, path_pattern, error_types, codigo, tiporespuesta, respuesta, customHeaders, activo)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [newRouteId, fb.orden || 0, fb.nombre, fb.path_pattern, errorTypes,
                            fb.codigo || '200', fb.tiporespuesta || 'json', fb.respuesta, fb.customHeaders, fb.activo ?? 1],
                            function(err) {
                                if (err) reject(err);
                                else resolve(this.lastID);
                            });
                    });
                    if (!results.fallbacks) results.fallbacks = { imported: 0 };
                    results.fallbacks.imported++;

                    // Import conditions for this fallback
                    if (fb.conditions && fb.conditions.length > 0 && newFallbackId) {
                        for (const cond of fb.conditions) {
                            await new Promise((resolve, reject) => {
                                db.run(`INSERT INTO proxy_fallback_conditions (fallback_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [newFallbackId, cond.orden || 0, cond.nombre, cond.criteria, cond.codigo,
                                    cond.tiporespuesta, cond.respuesta, cond.customHeaders, cond.activo ?? 1],
                                    function(err) {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                            });
                            if (!results.fallbackConditions) results.fallbackConditions = { imported: 0 };
                            results.fallbackConditions.imported++;
                        }
                    }
                }
            }
        }

        // Import files if requested
        if (importFiles && importData.files && importData.files.length > 0) {
            for (const fileInfo of importData.files) {
                const uploadFile = directory.files.find(f => f.path === `uploads/${fileInfo.storedName}`);
                if (uploadFile) {
                    const newRouteId = routeIdMap[fileInfo.routeId];
                    if (newRouteId) {
                        // Generate new filename
                        const ext = path.extname(fileInfo.originalName);
                        const newStoredName = `${uuidv4()}${ext}`;
                        const newFilePath = path.join(uploadsDir, newStoredName);

                        // Write file
                        const fileBuffer = await uploadFile.buffer();
                        fs.writeFileSync(newFilePath, fileBuffer);

                        // Update route with file info
                        await new Promise((resolve, reject) => {
                            db.run('UPDATE rutas SET fileName = ?, filePath = ?, fileMimeType = ? WHERE id = ?',
                                [fileInfo.originalName, `data/uploads/${newStoredName}`, fileInfo.mimeType, newRouteId],
                                (err) => {
                                    if (err) reject(err);
                                    else resolve();
                                });
                        });

                        results.files.imported++;
                    } else {
                        results.files.skipped++;
                    }
                } else {
                    results.files.skipped++;
                }
            }
        }

        res.json({
            success: true,
            results: results
        });

    } catch (error) {
        console.error('[IMPORT] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/export/preview
 * Get export statistics without creating the file
 */
router.get('/export/preview', async (req, res) => {
    try {
        const db = sqliteService.getDatabase();

        const routesCount = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM rutas', [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        const tagsCount = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM tags', [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        const conditionsCount = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM conditional_responses', [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        const fallbacksCount = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM proxy_fallbacks', [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        const routesWithFiles = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM rutas WHERE filePath IS NOT NULL AND filePath != ""', [], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        // Calculate files size
        let filesSize = 0;
        const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
        if (fs.existsSync(uploadsDir)) {
            const files = fs.readdirSync(uploadsDir);
            files.forEach(file => {
                const stats = fs.statSync(path.join(uploadsDir, file));
                filesSize += stats.size;
            });
        }

        res.json({
            success: true,
            stats: {
                routes: routesCount,
                tags: tagsCount,
                conditions: conditionsCount,
                fallbacks: fallbacksCount,
                files: routesWithFiles
            },
            filesSize: filesSize,
            filesSizeFormatted: formatBytes(filesSize)
        });

    } catch (error) {
        console.error('[EXPORT PREVIEW] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * POST /api/import/git
 * Clone a git repository and import its contents
 */
router.post('/import/git', async (req, res) => {
    try {
        const { repoUrl, branch, commit, sshKey, conflictStrategy } = req.body;

        if (!repoUrl) {
            return res.status(400).json({ error: 'Repository URL is required' });
        }

        // Import auto-import service
        const autoImportService = require('../services/auto-import.service');

        console.log(`[GIT IMPORT] Starting git import from: ${repoUrl}`);

        const results = await autoImportService.cloneAndImportGitRepo({
            repoUrl,
            branch: branch || null,
            commit: commit || null,
            sshKey: sshKey || null,
            conflictStrategy: conflictStrategy || 'skip'
        });

        res.json({
            success: true,
            results
        });

    } catch (error) {
        console.error('[GIT IMPORT] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/import/directory
 * List files available for import in the import directory
 */
router.get('/import/directory', async (req, res) => {
    try {
        const autoImportService = require('../services/auto-import.service');
        const importDir = autoImportService.IMPORT_DIR;

        if (!fs.existsSync(importDir)) {
            return res.json({ success: true, files: [] });
        }

        const files = [];
        const scanDirectory = (dir, relativePath = '') => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

                if (entry.isDirectory() && entry.name !== '.git') {
                    scanDirectory(fullPath, relPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    const baseName = path.basename(entry.name, ext).toLowerCase();

                    // Include ZIP files, and JSON/XML files with valid names
                    const isValidFile = ext === '.zip' ||
                        (ext === '.json' && (baseName === 'data' || baseName.includes('export') || baseName.includes('mock'))) ||
                        (ext === '.xml' && (baseName === 'data' || baseName.includes('export') || baseName.includes('mock')));

                    if (isValidFile) {
                        const stats = fs.statSync(fullPath);
                        files.push({
                            name: entry.name,
                            path: relPath,
                            type: ext.substring(1).toUpperCase(),
                            size: stats.size,
                            sizeFormatted: formatBytes(stats.size),
                            modified: stats.mtime
                        });
                    }
                }
            }
        };

        scanDirectory(importDir);

        res.json({
            success: true,
            files,
            directory: importDir
        });

    } catch (error) {
        console.error('[IMPORT DIRECTORY] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/import/directory
 * Import all files from the import directory
 */
router.post('/import/directory', async (req, res) => {
    try {
        const { conflictStrategy } = req.body;
        const autoImportService = require('../services/auto-import.service');

        console.log('[IMPORT DIRECTORY] Starting import from directory');

        const results = await autoImportService.importFromDirectory(
            autoImportService.IMPORT_DIR,
            conflictStrategy || 'skip'
        );

        res.json({
            success: true,
            results
        });

    } catch (error) {
        console.error('[IMPORT DIRECTORY] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
