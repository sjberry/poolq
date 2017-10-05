'use strict';

const chai = require('chai');
const expect = require('chai').expect;
const sinon = require('sinon');

const Pool = require('../main');


chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));


describe('Pool', function() {
	describe('property', function() {
		describe('state', function() {
			it('should be immutable', function() {
				function fn1() {
					Pool.states.ACTIVE = 'foo';
				}

				function fn2() {
					Pool.states.DRAINING = 'foo';
				}

				function fn3() {
					Pool.states.INACTIVE = 'foo';
				}

				return Promise.all([
					expect(fn1).to.throw,
					expect(fn2).to.throw,
					expect(fn3).to.throw
				]);
			});
		});
	});

	describe('instance property', function() {
		describe('count', function() {
			it('should indicate the number of allocated acquisition requests before any requests have been made', function() {
				let pool = new Pool();

				expect(pool.count).to.equal(0);
			});

			it('should indicate the number of allocated acquisition requests after a basic request has been made', async function() {
				let pool = new Pool();

				await pool.acquire();

				expect(pool.count).to.equal(1);
			});

			it('should correct indicate the number of allocated acquisition requests if the maximum has been exceeded', function() {
				const MAX = 1;
				const COUNT = 10;

				let pool = new Pool({
					max: MAX
				});

				for (let i = 0; i < COUNT; i++) {
					pool.acquire();
				}

				expect(pool.count).to.equal(MAX);
			});

			it('should indicate the correct number of outstanding, fulfilled acquisition requests when there are none remaining', async function() {
				let pool = new Pool();
				let slot = await pool.acquire();

				await pool.release(slot);

				expect(pool.count).to.equal(0);
			});
		});

		describe('draining', function() {
			it('should return `false` before the pool has been marked for draining', async function() {
				let pool = new Pool();

				expect(pool.draining).to.be.false;
			});

			it('should return `true` if the pool is currently draining', async function() {
				let pool = new Pool();

				await pool.acquire();
				pool.drain();

				expect(pool.draining).to.be.true;
			});

			it('should return `false` if the pool is completely drained', async function() {
				let pool = new Pool();
				let slot = await pool.acquire();

				pool.release(slot);
				await pool.drain();

				expect(pool.draining).to.be.false;
			});
		});

		describe('max', function() {
			it('should indicate the current maximum concurrent slots', function() {
				const MAX = 5;

				let pool = new Pool({
					max: MAX
				});

				expect(pool.max).to.equal(MAX);
			});

			it('should permit and maintain changes', function() {
				const OLD_MAX = 1;
				const NEW_MAX = 5;

				let pool = new Pool({
					max: OLD_MAX
				});

				expect(pool.max).to.equal(OLD_MAX);

				pool.max = NEW_MAX;

				expect(pool.max).to.equal(NEW_MAX);
			});

			it('should respond to dynamic increases, fulfilling acquisition requests as appropriate', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				let slot1 = pool.acquire();
				let slot2 = pool.acquire();

				let result = Promise.all([
					slot1,
					slot2
				]);

				pool.max = MAX + 1;

				await result;
			});
		});

		describe('waiting', function() {
			it('should indicate the number of pending acquisition requests', async function() {
				const MAX = 1;
				const COUNT = 10;

				let pool = new Pool({
					max: MAX
				});

				await pool.acquire();

				for (let i = 1; i < COUNT; i++) {
					pool.acquire();
				}

				expect(pool.waiting).to.equal(COUNT - MAX);
			});
		});
	});

	describe('instance method', function() {
		describe('acquire', function() {
			it('should supply work slots', async function() {
				let pool = new Pool();

				await pool.acquire();
			});

			it('should supply work slots up to a specific `max` cap', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				await pool.acquire();

				let acquisition = pool.acquire();
				let spy = sinon.spy();

				acquisition
					.then(function() {
						spy();
					});

				await expect(spy).to.not.have.been.called;
			});

			it('should continue to supply work slots after preceding slots have been released', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				let slot1 = pool.acquire();
				let slot2 = pool.acquire();

				slot1.then(function(slot) {
					pool.release(slot);
				});

				await Promise.all([
					slot1,
					slot2
				]);
			});
		});

		describe('drain', function() {
			it('should drain outstanding acquisition requests while still allowing them to finish', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				let slot = await pool.acquire();
				let draining = pool.drain();

				pool.release(slot);

				let drain = await draining;

				expect(drain).to.be.undefined;
			});

			it('should reject acquisition requests when draining', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				await pool.acquire();
				pool.drain();

				let promise = pool.acquire();

				return expect(promise).to.be.rejectedWith(Error, 'Pool is draining.');
			});

			it('should reject acquisition requests after draining', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				let slot = await pool.acquire();
				let draining = pool.drain();

				pool.release(slot);

				await draining;

				let promise = pool.acquire();

				return expect(promise).to.be.rejectedWith(Error, 'Pool is not active.');
			});
		});

		describe('release', function() {
			it('should release acquisition request slots to prevent pool blocking', async function() {
				const MAX = 1;

				let pool = new Pool({
					max: MAX
				});

				let slot = await pool.acquire();
				let slot2 = pool.acquire();

				await pool.release(slot);

				return expect(slot2).to.be.fulfilled;
			});

			it('should disallow releasing arbitrary acquisition that did not originate from the pool', async function() {
				let pool = new Pool();

				let promise = pool.release({});

				return expect(promise).to.be.rejectedWith(Error, 'Object was not obtained from this pool.');
			});

			it('should resolve all calls to release simultaneously (e.g. reference the same Promise)', async function() {
				let pool = new Pool();

				let slot = await pool.acquire();

				let promise1 = pool.release(slot);
				let promise2 = pool.release(slot);

				return expect(promise1 === promise2).to.be.true;
			});
		});

		describe('resume', function() {
			it('should resolve calls to an active pool', async function() {
				let pool = new Pool();

				await pool.resume();
			});

			it('should resolve calls to an inactive pool', async function() {
				let pool = new Pool();

				await pool.drain();
				await pool.resume();
			});

			it('should cancel the draining process when called on a draining pool before resuming', async function() {
				let pool = new Pool();

				await pool.acquire();

				let drain = pool.drain();
				let resume = pool.resume();

				return Promise.all([
					expect(drain).to.be.rejectedWith(Error, 'Pool resumed before completely draining.'),
					expect(resume).to.be.fulfilled
				]);
			});
		});
	});
});
