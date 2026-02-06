const semaphore = require('../../services/semaphore.service');

describe('SemaphoreService', () => {
    beforeEach(() => {
        // Initialize before each test to reset state
        semaphore.init();
    });

    describe('init', () => {
        test('should initialize with empty wait list', () => {
            semaphore.init();
            const list = semaphore.getList();
            expect(list).toEqual([]);
        });
    });

    describe('getList', () => {
        test('should return empty array when no items', () => {
            const list = semaphore.getList();
            expect(Array.isArray(list)).toBe(true);
            expect(list.length).toBe(0);
        });

        test('should return items added to wait list', async () => {
            const element = { id: 'test-1', url: '/test', sleep: true };

            // Start waiting in background
            const waitPromise = semaphore.addToListAndWait(element);

            // Check list immediately
            const list = semaphore.getList();
            expect(list.length).toBe(1);
            expect(list[0].id).toBe('test-1');
            expect(list[0].url).toBe('/test');

            // Wake up to clean up
            semaphore.wakeUp('test-1');
            await waitPromise;
        });
    });

    describe('generateUUID', () => {
        test('should generate valid UUID format', () => {
            const uuid = semaphore.generateUUID();
            // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            expect(uuid).toMatch(uuidRegex);
        });

        test('should generate unique UUIDs', () => {
            const uuid1 = semaphore.generateUUID();
            const uuid2 = semaphore.generateUUID();
            const uuid3 = semaphore.generateUUID();

            expect(uuid1).not.toBe(uuid2);
            expect(uuid2).not.toBe(uuid3);
            expect(uuid1).not.toBe(uuid3);
        });
    });

    describe('wakeUp', () => {
        test('should return false for non-existent id', () => {
            const result = semaphore.wakeUp('non-existent');
            expect(result).toBe(false);
        });

        test('should wake up waiting element', async () => {
            const element = { id: 'test-wake', url: '/test', sleep: true };

            // Start waiting
            const waitPromise = semaphore.addToListAndWait(element);

            // Element should be sleeping
            expect(element.sleep).toBe(true);

            // Wake up
            const result = semaphore.wakeUp('test-wake');
            expect(result).toBe(true);
            expect(element.sleep).toBe(false);

            await waitPromise;
        });

        test('should set custom response when provided', async () => {
            const element = { id: 'test-custom', url: '/test', sleep: true };
            const customResponse = { status: 500, body: { error: 'test error' } };

            // Start waiting
            const waitPromise = semaphore.addToListAndWait(element);

            // Wake up with custom response
            const result = semaphore.wakeUp('test-custom', customResponse);
            expect(result).toBe(true);
            expect(element.customResponse).toEqual(customResponse);

            await waitPromise;
        });

        test('should not set customResponse when null', async () => {
            const element = { id: 'test-no-custom', url: '/test', sleep: true };

            // Start waiting
            const waitPromise = semaphore.addToListAndWait(element);

            // Wake up without custom response
            const result = semaphore.wakeUp('test-no-custom', null);
            expect(result).toBe(true);
            expect(element.customResponse).toBeUndefined();

            await waitPromise;
        });
    });

    describe('addToListAndWait', () => {
        test('should add element to list', async () => {
            const element = { id: 'test-add', url: '/add', sleep: true };

            // Start waiting
            const waitPromise = semaphore.addToListAndWait(element);

            // Verify element is in list
            const list = semaphore.getList();
            expect(list).toContain(element);

            // Clean up
            semaphore.wakeUp('test-add');
            await waitPromise;
        });

        test('should remove element from list after wakeUp', async () => {
            const element = { id: 'test-remove', url: '/remove', sleep: true };

            // Start waiting
            const waitPromise = semaphore.addToListAndWait(element);

            // Verify element is in list
            expect(semaphore.getList().length).toBe(1);

            // Wake up
            semaphore.wakeUp('test-remove');
            await waitPromise;

            // Verify element is removed
            expect(semaphore.getList().length).toBe(0);
        });

        test('should handle multiple elements', async () => {
            const element1 = { id: 'multi-1', url: '/test1', sleep: true };
            const element2 = { id: 'multi-2', url: '/test2', sleep: true };
            const element3 = { id: 'multi-3', url: '/test3', sleep: true };

            // Start waiting for all
            const promises = [
                semaphore.addToListAndWait(element1),
                semaphore.addToListAndWait(element2),
                semaphore.addToListAndWait(element3)
            ];

            // Verify all elements are in list
            const list = semaphore.getList();
            expect(list.length).toBe(3);

            // Wake up in different order
            semaphore.wakeUp('multi-2');
            semaphore.wakeUp('multi-1');
            semaphore.wakeUp('multi-3');

            await Promise.all(promises);

            // All should be removed
            expect(semaphore.getList().length).toBe(0);
        });

        test('should resolve when sleep becomes false', async () => {
            const element = { id: 'test-resolve', url: '/test', sleep: true };

            let resolved = false;
            const waitPromise = semaphore.addToListAndWait(element).then(() => {
                resolved = true;
            });

            // Should not be resolved yet
            expect(resolved).toBe(false);

            // Wake up
            semaphore.wakeUp('test-resolve');

            // Wait for promise to resolve
            await waitPromise;

            expect(resolved).toBe(true);
        });
    });

    describe('integration scenarios', () => {
        test('should handle rapid add and wake cycles', async () => {
            const promises = [];

            for (let i = 0; i < 10; i++) {
                const element = { id: `rapid-${i}`, url: `/rapid/${i}`, sleep: true };
                promises.push(semaphore.addToListAndWait(element));

                // Immediately wake up
                setTimeout(() => semaphore.wakeUp(`rapid-${i}`), 10);
            }

            await Promise.all(promises);
            expect(semaphore.getList().length).toBe(0);
        });

        test('should maintain separate custom responses', async () => {
            const element1 = { id: 'resp-1', url: '/test1', sleep: true };
            const element2 = { id: 'resp-2', url: '/test2', sleep: true };

            const promises = [
                semaphore.addToListAndWait(element1),
                semaphore.addToListAndWait(element2)
            ];

            semaphore.wakeUp('resp-1', { code: 200 });
            semaphore.wakeUp('resp-2', { code: 404 });

            await Promise.all(promises);

            expect(element1.customResponse).toEqual({ code: 200 });
            expect(element2.customResponse).toEqual({ code: 404 });
        });
    });
});
