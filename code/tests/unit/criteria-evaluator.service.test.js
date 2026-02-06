const criteriaService = require('../../services/criteria-evaluator.service');

describe('CriteriaEvaluatorService', () => {
    describe('validateCriteria', () => {
        describe('valid expressions', () => {
            test('should accept simple equality check', () => {
                const result = criteriaService.validateCriteria("headers['x-api-key'] === 'secret'");
                expect(result.valid).toBe(true);
            });

            test('should accept body property access', () => {
                const result = criteriaService.validateCriteria("body.userId > 100");
                expect(result.valid).toBe(true);
            });

            test('should accept query param check', () => {
                const result = criteriaService.validateCriteria("query.debug === 'true'");
                expect(result.valid).toBe(true);
            });

            test('should accept method check', () => {
                const result = criteriaService.validateCriteria("method === 'post'");
                expect(result.valid).toBe(true);
            });

            test('should accept helper functions', () => {
                const result = criteriaService.validateCriteria("hasKey(body, 'email') && isNotEmpty(body.email)");
                expect(result.valid).toBe(true);
            });

            test('should accept combined conditions with AND', () => {
                const result = criteriaService.validateCriteria("headers['authorization'] && body.type === 'admin'");
                expect(result.valid).toBe(true);
            });

            test('should accept combined conditions with OR', () => {
                const result = criteriaService.validateCriteria("body.env === 'test' || query.mock === 'true'");
                expect(result.valid).toBe(true);
            });

            test('should accept match function with regex', () => {
                const result = criteriaService.validateCriteria("match(path, '/users/\\\\d+')");
                expect(result.valid).toBe(true);
            });

            test('should accept includes function', () => {
                const result = criteriaService.validateCriteria("includes(headers['content-type'], 'json')");
                expect(result.valid).toBe(true);
            });

            test('should accept array length check', () => {
                const result = criteriaService.validateCriteria("isArray(body.items) && length(body.items) > 0");
                expect(result.valid).toBe(true);
            });

            test('should accept numeric conversion', () => {
                const result = criteriaService.validateCriteria("toNumber(body.amount) >= 100");
                expect(result.valid).toBe(true);
            });
        });

        describe('invalid expressions', () => {
            test('should reject empty expression', () => {
                const result = criteriaService.validateCriteria('');
                expect(result.valid).toBe(false);
                expect(result.error).toBeDefined();
            });

            test('should reject null expression', () => {
                const result = criteriaService.validateCriteria(null);
                expect(result.valid).toBe(false);
            });

            test('should reject undefined expression', () => {
                const result = criteriaService.validateCriteria(undefined);
                expect(result.valid).toBe(false);
            });

            test('should reject whitespace-only expression', () => {
                const result = criteriaService.validateCriteria('   ');
                expect(result.valid).toBe(false);
            });

            test('should reject expressions exceeding max length', () => {
                const longExpression = 'a'.repeat(2001);
                const result = criteriaService.validateCriteria(longExpression);
                expect(result.valid).toBe(false);
                expect(result.error).toContain('2000');
            });

            test('should reject syntax errors', () => {
                const result = criteriaService.validateCriteria('if ( {');
                expect(result.valid).toBe(false);
                expect(result.error).toContain('sintaxis');
            });
        });

        describe('security - dangerous patterns', () => {
            test('should reject require()', () => {
                const result = criteriaService.validateCriteria("require('fs')");
                expect(result.valid).toBe(false);
                expect(result.error).toContain('no permitidos');
            });

            test('should reject eval()', () => {
                const result = criteriaService.validateCriteria("eval('code')");
                expect(result.valid).toBe(false);
            });

            test('should reject Function constructor', () => {
                const result = criteriaService.validateCriteria("new Function('return 1')");
                expect(result.valid).toBe(false);
            });

            test('should reject setTimeout', () => {
                const result = criteriaService.validateCriteria("setTimeout(() => {}, 1000)");
                expect(result.valid).toBe(false);
            });

            test('should reject setInterval', () => {
                const result = criteriaService.validateCriteria("setInterval(() => {}, 1000)");
                expect(result.valid).toBe(false);
            });

            test('should reject process access', () => {
                const result = criteriaService.validateCriteria("process.env.SECRET");
                expect(result.valid).toBe(false);
            });

            test('should reject global access', () => {
                const result = criteriaService.validateCriteria("global.something");
                expect(result.valid).toBe(false);
            });

            test('should reject globalThis access', () => {
                const result = criteriaService.validateCriteria("globalThis.something");
                expect(result.valid).toBe(false);
            });

            test('should reject __proto__ access', () => {
                const result = criteriaService.validateCriteria("body.__proto__");
                expect(result.valid).toBe(false);
            });

            test('should reject constructor access', () => {
                const result = criteriaService.validateCriteria("body.constructor");
                expect(result.valid).toBe(false);
            });

            test('should reject prototype access', () => {
                const result = criteriaService.validateCriteria("Object.prototype.hasOwnProperty");
                expect(result.valid).toBe(false);
            });

            test('should reject import statement', () => {
                const result = criteriaService.validateCriteria("import fs from 'fs'");
                expect(result.valid).toBe(false);
            });

            test('should reject dynamic import', () => {
                const result = criteriaService.validateCriteria("import('fs')");
                expect(result.valid).toBe(false);
            });

            test('should reject fs reference', () => {
                const result = criteriaService.validateCriteria("fs.readFileSync('/etc/passwd')");
                expect(result.valid).toBe(false);
            });

            test('should reject child_process reference', () => {
                const result = criteriaService.validateCriteria("child_process.exec('ls')");
                expect(result.valid).toBe(false);
            });
        });
    });

    describe('evaluateCriteria', () => {
        const baseContext = {
            headers: { 'x-api-key': 'secret', 'content-type': 'application/json' },
            body: { userId: 123, email: 'test@example.com', items: [1, 2, 3] },
            query: { debug: 'true', page: '2' },
            path: '/api/users/123',
            params: { id: '123' },
            method: 'POST'
        };

        describe('successful evaluations', () => {
            test('should evaluate header check correctly (true)', () => {
                const result = criteriaService.evaluateCriteria("headers['x-api-key'] === 'secret'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate header check correctly (false)', () => {
                const result = criteriaService.evaluateCriteria("headers['x-api-key'] === 'wrong'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('should evaluate body property (true)', () => {
                const result = criteriaService.evaluateCriteria("body.userId > 100", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate body property (false)', () => {
                const result = criteriaService.evaluateCriteria("body.userId < 100", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('should evaluate query param', () => {
                const result = criteriaService.evaluateCriteria("query.debug === 'true'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate method (lowercase conversion)', () => {
                const result = criteriaService.evaluateCriteria("method === 'post'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate path', () => {
                const result = criteriaService.evaluateCriteria("path === '/api/users/123'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate params', () => {
                const result = criteriaService.evaluateCriteria("params.id === '123'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate combined AND condition', () => {
                const result = criteriaService.evaluateCriteria("headers['x-api-key'] === 'secret' && body.userId > 100", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should evaluate combined OR condition', () => {
                const result = criteriaService.evaluateCriteria("body.userId < 100 || query.debug === 'true'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });
        });

        describe('helper functions', () => {
            test('includes - string contains', () => {
                const result = criteriaService.evaluateCriteria("includes(headers['content-type'], 'json')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('includes - string not contains', () => {
                const result = criteriaService.evaluateCriteria("includes(headers['content-type'], 'xml')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('includes - array contains', () => {
                const result = criteriaService.evaluateCriteria("includes(body.items, 2)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('startsWith', () => {
                const result = criteriaService.evaluateCriteria("startsWith(path, '/api')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('endsWith', () => {
                const result = criteriaService.evaluateCriteria("endsWith(path, '123')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('match - regex pattern', () => {
                const result = criteriaService.evaluateCriteria("match(path, '/api/users/\\\\d+')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('hasKey - exists', () => {
                const result = criteriaService.evaluateCriteria("hasKey(body, 'email')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('hasKey - not exists', () => {
                const result = criteriaService.evaluateCriteria("hasKey(body, 'nonexistent')", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('isEmpty - empty string', () => {
                const context = { ...baseContext, body: { name: '' } };
                const result = criteriaService.evaluateCriteria("isEmpty(body.name)", context);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('isEmpty - non-empty string', () => {
                const result = criteriaService.evaluateCriteria("isEmpty(body.email)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('isNotEmpty', () => {
                const result = criteriaService.evaluateCriteria("isNotEmpty(body.email)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('isNumber', () => {
                const result = criteriaService.evaluateCriteria("isNumber(body.userId)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('isString', () => {
                const result = criteriaService.evaluateCriteria("isString(body.email)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('isArray', () => {
                const result = criteriaService.evaluateCriteria("isArray(body.items)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('length - array', () => {
                const result = criteriaService.evaluateCriteria("length(body.items) === 3", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('length - string', () => {
                const result = criteriaService.evaluateCriteria("length(body.email) > 5", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('toNumber', () => {
                const result = criteriaService.evaluateCriteria("toNumber(query.page) === 2", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('toLowerCase', () => {
                const context = { ...baseContext, headers: { 'x-env': 'PRODUCTION' } };
                const result = criteriaService.evaluateCriteria("toLowerCase(headers['x-env']) === 'production'", context);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('toUpperCase', () => {
                const result = criteriaService.evaluateCriteria("toUpperCase(method) === 'POST'", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('equals', () => {
                const result = criteriaService.evaluateCriteria("equals(body.userId, 123)", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('first - array', () => {
                const result = criteriaService.evaluateCriteria("first(body.items) === 1", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('last - array', () => {
                const result = criteriaService.evaluateCriteria("last(body.items) === 3", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });
        });

        describe('edge cases', () => {
            test('should handle missing headers gracefully', () => {
                const context = { ...baseContext, headers: {} };
                const result = criteriaService.evaluateCriteria("headers['x-api-key'] === 'secret'", context);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('should handle null body gracefully', () => {
                const context = { ...baseContext, body: null };
                const result = criteriaService.evaluateCriteria("hasKey(body, 'userId')", context);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('should handle undefined values', () => {
                const context = { ...baseContext };
                delete context.query;
                const result = criteriaService.evaluateCriteria("query.debug === 'true'", context);
                expect(result.success).toBe(true);
                expect(result.result).toBe(false);
            });

            test('should convert boolean result', () => {
                const result = criteriaService.evaluateCriteria("body.userId", baseContext);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });

            test('should handle complex nested access', () => {
                const context = {
                    ...baseContext,
                    body: { user: { profile: { settings: { theme: 'dark' } } } }
                };
                const result = criteriaService.evaluateCriteria("body.user.profile.settings.theme === 'dark'", context);
                expect(result.success).toBe(true);
                expect(result.result).toBe(true);
            });
        });

        describe('error handling', () => {
            test('should return error for invalid expressions', () => {
                const result = criteriaService.evaluateCriteria('', baseContext);
                expect(result.success).toBe(false);
                expect(result.result).toBe(false);
                expect(result.error).toBeDefined();
            });

            test('should return error for dangerous patterns', () => {
                const result = criteriaService.evaluateCriteria("require('fs')", baseContext);
                expect(result.success).toBe(false);
                expect(result.result).toBe(false);
            });
        });
    });

    describe('ALLOWED_HELPERS', () => {
        const helpers = criteriaService.ALLOWED_HELPERS;

        describe('includes', () => {
            test('should work with arrays', () => {
                expect(helpers.includes([1, 2, 3], 2)).toBe(true);
                expect(helpers.includes([1, 2, 3], 4)).toBe(false);
            });

            test('should work with strings', () => {
                expect(helpers.includes('hello world', 'world')).toBe(true);
                expect(helpers.includes('hello world', 'foo')).toBe(false);
            });

            test('should handle null/undefined', () => {
                expect(helpers.includes(null, 'test')).toBe(false);
                expect(helpers.includes(undefined, 'test')).toBe(false);
            });
        });

        describe('isEmpty', () => {
            test('should return true for null/undefined', () => {
                expect(helpers.isEmpty(null)).toBe(true);
                expect(helpers.isEmpty(undefined)).toBe(true);
            });

            test('should return true for empty string', () => {
                expect(helpers.isEmpty('')).toBe(true);
                expect(helpers.isEmpty('   ')).toBe(true);
            });

            test('should return true for empty array', () => {
                expect(helpers.isEmpty([])).toBe(true);
            });

            test('should return true for empty object', () => {
                expect(helpers.isEmpty({})).toBe(true);
            });

            test('should return false for non-empty values', () => {
                expect(helpers.isEmpty('hello')).toBe(false);
                expect(helpers.isEmpty([1])).toBe(false);
                expect(helpers.isEmpty({ a: 1 })).toBe(false);
            });
        });

        describe('match', () => {
            test('should match regex patterns', () => {
                expect(helpers.match('/users/123', '/users/\\d+')).toBe(true);
                expect(helpers.match('/users/abc', '/users/\\d+')).toBe(false);
            });

            test('should handle invalid regex gracefully', () => {
                expect(helpers.match('test', '[invalid')).toBe(false);
            });

            test('should handle null/undefined', () => {
                expect(helpers.match(null, 'test')).toBe(false);
                expect(helpers.match(undefined, 'test')).toBe(false);
            });
        });

        describe('length', () => {
            test('should return array length', () => {
                expect(helpers.length([1, 2, 3])).toBe(3);
            });

            test('should return string length', () => {
                expect(helpers.length('hello')).toBe(5);
            });

            test('should return object keys count', () => {
                expect(helpers.length({ a: 1, b: 2 })).toBe(2);
            });

            test('should return 0 for null/undefined', () => {
                expect(helpers.length(null)).toBe(0);
                expect(helpers.length(undefined)).toBe(0);
            });
        });

        describe('toNumber', () => {
            test('should convert string to number', () => {
                expect(helpers.toNumber('123')).toBe(123);
                expect(helpers.toNumber('12.5')).toBe(12.5);
            });

            test('should return 0 for NaN', () => {
                expect(helpers.toNumber('not a number')).toBe(0);
            });

            test('should pass through numbers', () => {
                expect(helpers.toNumber(42)).toBe(42);
            });
        });
    });

    describe('getAvailableHelpers', () => {
        test('should return array of helper names', () => {
            const helpers = criteriaService.getAvailableHelpers();
            expect(Array.isArray(helpers)).toBe(true);
            expect(helpers).toContain('includes');
            expect(helpers).toContain('hasKey');
            expect(helpers).toContain('isEmpty');
            expect(helpers).toContain('isNotEmpty');
            expect(helpers).toContain('match');
            expect(helpers).toContain('length');
        });
    });

    describe('getExamples', () => {
        test('should return array of example objects', () => {
            const examples = criteriaService.getExamples();
            expect(Array.isArray(examples)).toBe(true);
            expect(examples.length).toBeGreaterThan(0);
            examples.forEach(example => {
                expect(example).toHaveProperty('expression');
                expect(example).toHaveProperty('description');
            });
        });
    });
});
