/**
 * Auto-Import Service
 * Handles automatic importing of routes from files and git repositories on startup
 */

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const unzipper = require('unzipper');
const { v4: uuidv4 } = require('uuid');

// Import directory path
const IMPORT_DIR = path.join(__dirname, '..', 'data', 'import');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

// Environment variables
const ENV_GIT_REPO = process.env.MOCK_SERVER_GIT_REPO;
const ENV_GIT_BRANCH = process.env.MOCK_SERVER_GIT_BRANCH;
const ENV_GIT_COMMIT = process.env.MOCK_SERVER_GIT_COMMIT;
const ENV_GIT_SSH_KEY = process.env.MOCK_SERVER_GIT_SSH_KEY;
const ENV_CONFLICT_STRATEGY = process.env.MOCK_SERVER_IMPORT_CONFLICT || 'skip';

let sqliteService = null;

/**
 * Initialize the auto-import service
 */
async function init(sqlite) {
    sqliteService = sqlite;

    // Ensure import directory exists
    if (!fs.existsSync(IMPORT_DIR)) {
        fs.mkdirSync(IMPORT_DIR, { recursive: true });
        console.log('[AUTO-IMPORT] Created import directory:', IMPORT_DIR);
    }

    // Ensure uploads directory exists
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
}

/**
 * Run auto-import on startup
 * 1. Check for git repo in environment variables
 * 2. Check for files in import directory
 */
async function runStartupImport() {
    console.log('[AUTO-IMPORT] Checking for startup imports...');

    // Check for git repository in environment variables
    if (ENV_GIT_REPO) {
        console.log('[AUTO-IMPORT] Found git repository in environment variables');
        try {
            await cloneAndImportGitRepo({
                repoUrl: ENV_GIT_REPO,
                branch: ENV_GIT_BRANCH,
                commit: ENV_GIT_COMMIT,
                sshKey: ENV_GIT_SSH_KEY,
                conflictStrategy: ENV_CONFLICT_STRATEGY
            });
        } catch (error) {
            console.error('[AUTO-IMPORT] Error importing from git:', error.message);
        }
    }

    // Check for files in import directory
    await importFromDirectory(IMPORT_DIR, ENV_CONFLICT_STRATEGY);
}

/**
 * Import all valid files from a directory (recursively)
 * Supports: .zip files, .json files (data.json format), .xml files (data.xml format)
 */
async function importFromDirectory(directory, conflictStrategy = 'skip') {
    if (!fs.existsSync(directory)) {
        return { imported: 0, errors: [] };
    }

    const results = { imported: 0, errors: [] };

    const processDirectory = async (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // Skip .git directories
                if (entry.name === '.git') continue;
                await processDirectory(fullPath);
            } else if (entry.isFile()) {
                // Check if it's a valid import file
                const ext = path.extname(entry.name).toLowerCase();
                const baseName = path.basename(entry.name, ext).toLowerCase();

                try {
                    if (ext === '.zip') {
                        console.log(`[AUTO-IMPORT] Importing ZIP file: ${fullPath}`);
                        await importZipFile(fullPath, conflictStrategy);
                        results.imported++;
                    } else if (ext === '.json' && (baseName === 'data' || baseName.includes('export') || baseName.includes('mock'))) {
                        console.log(`[AUTO-IMPORT] Importing JSON file: ${fullPath}`);
                        await importJsonFile(fullPath, conflictStrategy);
                        results.imported++;
                    } else if (ext === '.xml' && (baseName === 'data' || baseName.includes('export') || baseName.includes('mock'))) {
                        console.log(`[AUTO-IMPORT] Importing XML file: ${fullPath}`);
                        await importXmlFile(fullPath, conflictStrategy);
                        results.imported++;
                    }
                } catch (error) {
                    console.error(`[AUTO-IMPORT] Error importing ${fullPath}:`, error.message);
                    results.errors.push({ file: fullPath, error: error.message });
                }
            }
        }
    };

    await processDirectory(directory);

    if (results.imported > 0) {
        console.log(`[AUTO-IMPORT] Imported ${results.imported} file(s) from ${directory}`);
    }

    return results;
}

/**
 * Import from a JSON file (uncompressed data.json format)
 */
async function importJsonFile(filePath, conflictStrategy = 'skip') {
    const db = sqliteService.getDatabase();
    const content = fs.readFileSync(filePath, 'utf8');
    const importData = JSON.parse(content);

    return await importDataObject(db, importData, conflictStrategy);
}

/**
 * Import from an XML file (uncompressed data.xml format)
 */
async function importXmlFile(filePath, conflictStrategy = 'skip') {
    const db = sqliteService.getDatabase();
    const content = fs.readFileSync(filePath, 'utf8');
    const importData = xmlToRoutes(content);

    return await importDataObject(db, importData, conflictStrategy);
}

/**
 * Common import logic for data objects
 */
async function importDataObject(db, importData, conflictStrategy) {
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
        const existing = await dbGet(db, 'SELECT * FROM tags WHERE name = ? COLLATE NOCASE', [tag.name]);

        if (existing) {
            results.tags.skipped++;
        } else {
            const newId = tag.id || uuidv4();
            await dbRun(db, 'INSERT INTO tags (id, name, color) VALUES (?, ?, ?)',
                [newId, tag.name, tag.color || '#6366f1']);
            results.tags.imported++;
        }
    }

    // Get max order
    let maxOrder = (await dbGet(db, 'SELECT MAX(orden) as maxOrder FROM rutas', []))?.maxOrder || 0;

    // Import routes
    for (const route of (importData.routes || [])) {
        const oldId = route.id;

        // Check for existing route with same path and method
        const existing = await dbGet(db, 'SELECT * FROM rutas WHERE ruta = ? AND tipo = ?', [route.ruta, route.tipo]);

        let newRouteId;

        if (existing) {
            if (conflictStrategy === 'skip') {
                results.routes.skipped++;
                routeIdMap[oldId] = existing.id;
                continue;
            } else if (conflictStrategy === 'overwrite') {
                await dbRun(db, `UPDATE rutas SET codigo = ?, respuesta = ?, tiporespuesta = ?, esperaActiva = ?,
                    isRegex = ?, customHeaders = ?, activo = ?, tags = ?, operationId = ?, summary = ?, description = ?, requestBodyExample = ?
                    WHERE id = ?`,
                    [route.codigo, route.respuesta, route.tiporespuesta, route.esperaActiva || 0,
                    route.isRegex || 0, route.customHeaders, route.activo ?? 1,
                    route.tags, route.operationId, route.summary, route.description, route.requestBodyExample, existing.id]);

                await dbRun(db, 'DELETE FROM conditional_responses WHERE route_id = ?', [existing.id]);
                newRouteId = existing.id;
                results.routes.updated++;
            } else {
                // Duplicate
                maxOrder++;
                const newRuta = route.ruta + '_imported_' + Date.now();
                newRouteId = await dbRunGetId(db, `INSERT INTO rutas (tipo, ruta, codigo, tiporespuesta, respuesta, esperaActiva,
                    isRegex, customHeaders, activo, orden, tags, operationId, summary, description, requestBodyExample)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [route.tipo, newRuta, route.codigo, route.tiporespuesta, route.respuesta,
                    route.esperaActiva || 0, route.isRegex || 0, route.customHeaders, route.activo ?? 1,
                    maxOrder, route.tags, route.operationId, route.summary, route.description, route.requestBodyExample]);
                results.routes.imported++;
            }
        } else {
            maxOrder++;
            newRouteId = await dbRunGetId(db, `INSERT INTO rutas (tipo, ruta, codigo, tiporespuesta, respuesta, esperaActiva,
                isRegex, customHeaders, activo, orden, tags, operationId, summary, description, requestBodyExample)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [route.tipo, route.ruta, route.codigo, route.tiporespuesta, route.respuesta,
                route.esperaActiva || 0, route.isRegex || 0, route.customHeaders, route.activo ?? 1,
                maxOrder, route.tags, route.operationId, route.summary, route.description, route.requestBodyExample]);
            results.routes.imported++;
        }

        routeIdMap[oldId] = newRouteId;

        // Import conditions for this route
        const conditions = route.conditions || importData.conditions?.filter(c => c.routeId === oldId) || [];
        for (const cond of conditions) {
            if (newRouteId) {
                await dbRun(db, `INSERT INTO conditional_responses (route_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [newRouteId, cond.orden || 0, cond.nombre, cond.criteria || cond.criterio, cond.codigo,
                    cond.tiporespuesta, cond.respuesta, cond.customHeaders, cond.activo ?? 1]);
                results.conditions.imported++;
            }
        }
    }

    // Import conditions that are not embedded in routes
    if (importData.conditions) {
        for (const cond of importData.conditions) {
            const newRouteId = routeIdMap[cond.routeId];
            if (newRouteId && !importData.routes?.find(r => r.conditions?.some(c => c.id === cond.id))) {
                await dbRun(db, `INSERT INTO conditional_responses (route_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [newRouteId, cond.orden || 0, cond.nombre, cond.criteria || cond.criterio, cond.codigo,
                    cond.tiporespuesta, cond.respuesta, cond.customHeaders, cond.activo ?? 1]);
                results.conditions.imported++;
            }
        }
    }

    console.log(`[AUTO-IMPORT] Import results: Routes(${results.routes.imported} new, ${results.routes.updated} updated, ${results.routes.skipped} skipped), Tags(${results.tags.imported}), Conditions(${results.conditions.imported})`);

    return results;
}

/**
 * Import a single zip file
 */
async function importZipFile(filePath, conflictStrategy = 'skip') {
    const db = sqliteService.getDatabase();
    const zipBuffer = fs.readFileSync(filePath);
    const directory = await unzipper.Open.buffer(zipBuffer);

    // Find and parse manifest
    const manifestFile = directory.files.find(f => f.path === 'manifest.json');
    if (!manifestFile) {
        throw new Error('Invalid export file: manifest.json not found');
    }
    const manifestContent = await manifestFile.buffer();
    const manifest = JSON.parse(manifestContent.toString());

    // Find and parse data file
    const dataFileName = manifest.format === 'xml' ? 'data.xml' : 'data.json';
    const dataFile = directory.files.find(f => f.path === dataFileName);
    if (!dataFile) {
        throw new Error(`Invalid export file: ${dataFileName} not found`);
    }
    const dataContent = await dataFile.buffer();

    let importData;
    if (manifest.format === 'xml') {
        importData = xmlToRoutes(dataContent.toString());
    } else {
        importData = JSON.parse(dataContent.toString());
    }

    // Use common import logic for routes, tags, and conditions
    const results = await importDataObject(db, importData, conflictStrategy);

    // Import files from ZIP (this is ZIP-specific logic)
    if (importData.files && importData.files.length > 0) {
        // Build routeIdMap by matching routes
        const routeIdMap = {};
        for (const route of (importData.routes || [])) {
            const existing = await dbGet(db, 'SELECT * FROM rutas WHERE ruta = ? AND tipo = ?', [route.ruta, route.tipo]);
            if (existing) {
                routeIdMap[route.id] = existing.id;
            }
        }

        for (const fileInfo of importData.files) {
            const uploadFile = directory.files.find(f => f.path === `uploads/${fileInfo.storedName}`);
            if (uploadFile) {
                const newRouteId = routeIdMap[fileInfo.routeId];
                if (newRouteId) {
                    const ext = path.extname(fileInfo.originalName);
                    const newStoredName = `${uuidv4()}${ext}`;
                    const newFilePath = path.join(UPLOADS_DIR, newStoredName);

                    const fileBuffer = await uploadFile.buffer();
                    fs.writeFileSync(newFilePath, fileBuffer);

                    await dbRun(db, 'UPDATE rutas SET fileName = ?, filePath = ?, fileMimeType = ? WHERE id = ?',
                        [fileInfo.originalName, `data/uploads/${newStoredName}`, fileInfo.mimeType, newRouteId]);

                    results.files.imported++;
                } else {
                    results.files.skipped++;
                }
            } else {
                results.files.skipped++;
            }
        }
    }

    return results;
}

/**
 * Clone a git repository and import its contents
 */
async function cloneAndImportGitRepo(options) {
    const { repoUrl, branch, commit, sshKey, conflictStrategy = 'skip' } = options;

    if (!repoUrl) {
        throw new Error('Repository URL is required');
    }

    const cloneDir = path.join(IMPORT_DIR, `git_clone_${Date.now()}`);

    try {
        console.log(`[AUTO-IMPORT] Cloning repository: ${repoUrl}`);

        // Build git clone command
        let gitEnv = { ...process.env };
        let gitCommand = 'git clone';

        // Handle SSH key
        if (sshKey) {
            const sshKeyPath = path.join(IMPORT_DIR, `ssh_key_${Date.now()}`);
            fs.writeFileSync(sshKeyPath, sshKey, { mode: 0o600 });
            gitEnv.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no`;
        }

        // Add branch if specified
        if (branch) {
            gitCommand += ` --branch ${branch}`;
        }

        // Add depth to speed up cloning
        gitCommand += ' --depth 1';

        // Add repo URL and destination
        gitCommand += ` "${repoUrl}" "${cloneDir}"`;

        // Execute git clone
        execSync(gitCommand, {
            env: gitEnv,
            stdio: 'pipe',
            timeout: 120000 // 2 minute timeout
        });

        console.log(`[AUTO-IMPORT] Repository cloned to: ${cloneDir}`);

        // Checkout specific commit if specified
        if (commit) {
            console.log(`[AUTO-IMPORT] Checking out commit: ${commit}`);
            execSync(`git checkout ${commit}`, {
                cwd: cloneDir,
                env: gitEnv,
                stdio: 'pipe'
            });
        }

        // Import files from cloned directory
        const results = await importFromDirectory(cloneDir, conflictStrategy);

        return results;

    } finally {
        // Clean up cloned directory
        if (fs.existsSync(cloneDir)) {
            console.log(`[AUTO-IMPORT] Cleaning up cloned repository: ${cloneDir}`);
            fs.rmSync(cloneDir, { recursive: true, force: true });
        }

        // Clean up SSH key if created
        const sshKeyFiles = fs.readdirSync(IMPORT_DIR).filter(f => f.startsWith('ssh_key_'));
        for (const keyFile of sshKeyFiles) {
            fs.unlinkSync(path.join(IMPORT_DIR, keyFile));
        }
    }
}

/**
 * Clone a git repository via API (async, for UI usage)
 */
function cloneGitRepoAsync(options) {
    return new Promise((resolve, reject) => {
        cloneAndImportGitRepo(options)
            .then(resolve)
            .catch(reject);
    });
}

// Helper functions for database operations
function dbGet(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

function dbRunGetId(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
}

// Simple XML parser (same as in export-import.js)
function xmlToRoutes(xmlString) {
    // Basic XML to JSON conversion for our export format
    const data = { routes: [], tags: [], conditions: [] };

    // Extract routes
    const routesMatch = xmlString.match(/<routes>([\s\S]*?)<\/routes>/);
    if (routesMatch) {
        const routeMatches = routesMatch[1].matchAll(/<route>([\s\S]*?)<\/route>/g);
        for (const match of routeMatches) {
            const route = {};
            const content = match[1];
            const fields = ['id', 'orden', 'tipo', 'ruta', 'codigo', 'tiporespuesta', 'respuesta',
                'isRegex', 'activo', 'esperaActiva', 'proxyDestination', 'customHeaders',
                'fileToReturn', 'tags', 'operationId', 'summary', 'description', 'requestBodyExample'];
            for (const field of fields) {
                const fieldMatch = content.match(new RegExp(`<${field}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${field}>|<${field}>([^<]*)<\\/${field}>`));
                if (fieldMatch) {
                    route[field] = fieldMatch[1] || fieldMatch[2] || '';
                }
            }
            if (route.id) {
                route.id = parseInt(route.id);
                route.orden = parseInt(route.orden) || 0;
                route.isRegex = parseInt(route.isRegex) || 0;
                route.activo = parseInt(route.activo) ?? 1;
                route.esperaActiva = parseInt(route.esperaActiva) || 0;
            }
            data.routes.push(route);
        }
    }

    // Extract tags
    const tagsMatch = xmlString.match(/<tags>([\s\S]*?)<\/tags>/);
    if (tagsMatch) {
        const tagMatches = tagsMatch[1].matchAll(/<tag>([\s\S]*?)<\/tag>/g);
        for (const match of tagMatches) {
            const tag = {};
            const content = match[1];
            const idMatch = content.match(/<id>([^<]*)<\/id>/);
            const nameMatch = content.match(/<name>([^<]*)<\/name>/);
            const colorMatch = content.match(/<color>([^<]*)<\/color>/);
            if (idMatch) tag.id = idMatch[1];
            if (nameMatch) tag.name = nameMatch[1];
            if (colorMatch) tag.color = colorMatch[1];
            data.tags.push(tag);
        }
    }

    return data;
}

module.exports = {
    init,
    runStartupImport,
    importFromDirectory,
    importZipFile,
    cloneAndImportGitRepo,
    cloneGitRepoAsync,
    IMPORT_DIR
};
