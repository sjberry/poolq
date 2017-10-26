'use strict';

const Deferred = require('deferred-ap');
const PriorityQueue = require('js-priority-queue');


// A collection of mappings to, in effect, create private instance variables and prevent tampering. Underscore preceded
// variable names (e.g. `_count`) would be a legitimate, and perhaps more standard, option.
let maps = {
	count: new WeakMap(),
	max: new WeakMap(),
	origin: new WeakMap(),
	queue: new WeakMap(),
	releases: new WeakMap(),
	state: new WeakMap(),
	transition: new WeakMap()
};

// An enumeration of the possible pool states referenced internally.
const states = {
	ACTIVE: 'active',
	DRAINING: 'draining',
	INACTIVE: 'inactive',
	RESUMING: 'resuming'
};

// We want to freeze this object so that the states are accessible but still immutable.
Object.freeze(states);


/**
 * Accepts a synchronous or asynchronous function and returns a wrapped function that will wrap the returned value in
 * a Promise if it not already one, effectively converting any synchronous function to asynchronous and leaving
 * asynchronous functions essentially unchanged.
 *
 * @private
 * @param {Function} fn A synchronous or asynchronous function.
 * @returns {Function} An asynchronous wrapper function that will intercept synchronous return values and return a
 *     resolved Promise or catch synchronous errors to return a rejected Promise.
 */
function promisify(fn) {
	return function() {
		let result;

		try {
			result = fn.apply(this, arguments);

			if (result instanceof Promise || (result != null && typeof result === 'object' && typeof result.then === 'function' && typeof result.catch === 'function')) {
				return result;
			}
		} catch(err) {
			return Promise.reject(err);
		}

		return Promise.resolve(result);
	};
}


/**
 * Attempts to fill any available pool slots and spawn appropriate acquisition requests. "Filling" amounts to issuing
 * acquisition requests up to the stipulated maximum on the instance (or all acquisition requests if there are fewer
 * than the permitted maximum).
 *
 * @private
 * @param {Pool} pool The pool instance that should be "filled"
 */
function fill(pool) {
	let queue = maps.queue.get(pool);

	// While the current count is less than the allotted maximum and there are outstanding acquisition requests, attempt
	// to fill the available space.
	while (pool.count < pool.max && pool.waiting > 0) {
		spawn(pool, queue.dequeue().deferred);
	}
}


/**
 * An embedded no-op. Used to reduce the number of bloat dependencies.
 *
 * @private
 */
function noop() {}


/**
 * A simple comparator to interface with the underlying PriorityQueue. Queue objects are constructed internally, so the
 * `priority` property can be guaranteed. The comparator itself stipulates the order that acquisition requests will be
 * fulfilled.
 *
 * @private
 * @param {Object} a A primary queue object to compare.
 * @param {Object} b A secondary queue object to compare.
 * @returns {Number} The relative priority indicating to the PriorityQueue the insertion order.
 */
function queueComparator(a, b) {
	return b.priority - a.priority;
}


/**
 * Normalizes the spawning process of the pool elements and appropriately tracks the number of active, fulfilled
 * requests.
 *
 * @private
 * @param {Pool} pool The pool instance that is being operated on.
 * @param {Object} deferred An internal "deferred" object that can be used to reject or resolve the original
 *     acquisition requests.
 * @returns {Promise} A promise that is resolved when the pool object is successfully created.
 */
function spawn(pool, deferred) {
	// Make sure to increase the counter. If there is an error during creation we'll just decrease the counter again.
	// But if the object takes a particularly long time to create we don't want any other acquisition requests cutting
	// in line.
	let count = maps.count.get(pool);

	count++;
	maps.count.set(pool, count);

	return pool._create()
		.then(function(obj) {
			// When the object is successfully created, mark it as originating from this pool.
			maps.origin.set(obj, pool);

			// Resolve the original acquisition request.
			deferred.resolve(obj);
		})
		.catch(function(err) {
			// There was an error during object creation, so reject the original acquisition request.
			deferred.reject(err);

			// Decrease the count of the pool to "undo" the pre-emptive increment.
			count--;
			maps.count.set(pool, count);
		});
}


/**
 * A class that serves as a constructor for the default object acquired from the pool if no creation function is
 * specified.
 *
 * @private
 * @constructor
 */
class Slot {
	constructor() {}

	static create() {
		return new Slot();
	}
}


/**
 * Placeholder.
 *
 * @class
 * @param {Object} options A configuration object.
 * @param {Function} options.create A function that will be called to create a new pool element. Can be synchronous or
 *     asynchronous. The function must not return pool elements that are of type 'undefined', 'null', 'number',
 *     'boolean', or 'string'. Only 'object' types and its derivatives are supported.
 * @param {Function} [options.destroy] A function that will be called to destroy a pool element. Will be passed the
 *     pool element marked for destruction as the only argument.
 * @param {Number} [max=1] The initial maximum number of objects in the pool. Must be a positive integer greater than
 *     0. Non-conforming values are coerced with truncation or, failing that, defaulting back to 1.
 */
class Pool {
	constructor(options = {}) {
		// An internal count of the currently fulfilled acquisition requests. Note that this is NOT the same as the
		// length of the underlying queue itself.
		maps.count.set(this, 0);
		// An internal reference to keep track of the maximum size of the pool.
		maps.max.set(this, Infinity);
		// An internal priority queue for keeping track of acquisition requests.
		maps.queue.set(this, new PriorityQueue({
			comparator: queueComparator
		}));
		maps.releases.set(this, new WeakMap());
		// An internal reference to keep track of the state of the pool.
		maps.state.set(this, 'active');

		// TODO: Enforce the function? type for the `options.create` parameter.
		// A asynchronous/synchronous normalized version of the supplied create option.
		this._create = promisify(options.create || Slot.create);
		// TODO: Enforce the function? type for the `options.destroy` paramter.
		// A asynchronous/synchronous normalized version of the supplied destroy option.
		this._destroy = promisify(options.destroy || noop);
		// TODO: Enforce the inteter? type for the `options.max` parameter.
		this.max = options.max;
	}

	/**
	 * Acquires a new object from the pool asynchronously. The returned Promise will resolve when there is a free slot
	 * available in the pool. However the promise will be rejected if any errors are encountered during object creation
	 * (using the configured options.create function) or if an attempt is made to acquire a new pool object when the
	 * pool has already been marked for draining.
	 *
	 * @param {Number} [priority=1] The priority with which to obtain a new element from the pool.
	 * @returns {Promise} A promise that is resolved when the object is successfully created.
	 */
	acquire(priority = 1) {
		// FIXME: Enforce the integer type for the `priority` parameter.

		let state = maps.state.get(this);

		// Check to see if the pool is active. If not, we shouldn't be able to obtain a new slot.
		if (state === states.INACTIVE) {
			return Promise.reject(new Error('Pool is not active.'));
		}
		else if (state === states.DRAINING) {
			return Promise.reject(new Error('Pool is draining.'));
		}

		let deferred = new Deferred();
		let queue = maps.queue.get(this);

		// Queue a new "deferred" with the specified priority. We want to queue
		queue.queue({
			deferred: deferred,
			priority: isNaN(priority) ? 1 : priority
		});

		// If the current count is less than the maximum size we can immediately dequeue and process the acquisition
		// request.
		if (this.count < this.max) {
			spawn(this, queue.dequeue().deferred);
		}

		return deferred.promise;
	}

	/**
	 * Marks the pool for draining. Once drained, no additional acquisition requests will succeed. Outstanding,
	 * fulfilled requests will be allowed to exist and make use of `.release()`. The pool may be resumed with
	 * `.resume()` at any time to re-enable acquisitions.
	 *
	 * @returns {Promise} A Promise that is resolved when the pool is successfully drained (0 oustanding acquisitions).
	 *     If the pool is resumed before it is completely drained, this returned promise will reject.
	 */
	drain() {
		// This is a function evaluation with a more complex lookup, so we'll just save a little time here at the cost
		// of a marginal amount of temporal memory.
		let state = maps.state.get(this);

		// If the pool is currently draining, then we should just return the existing transition promise.
		if (state === states.DRAINING) {
			return maps.transition.get(this).promise;
		}

		// If the pool is currently inactive, then we should just return a resolved promise immediately.
		if (state === states.INACTIVE) {
			return Promise.resolve();
		}

		if (state === states.ACTIVE) {
			// If our `count` is currently zero (e.g. there are no outstanding, un-returned acquisitions requests) then we
			// can return a resolved promise immediately to cut out unnecessary processing.
			if (this.count === 0) {
				maps.state.set(this, states.INACTIVE);

				return Promise.resolve();
			}

			let self = this;
			let deferred = new Deferred();

			deferred.promise = deferred.promise
				.then(function() {
					maps.transition.delete(self);
					maps.state.set(self, states.INACTIVE);
				});

			maps.transition.set(this, deferred);
			maps.state.set(this, states.DRAINING);

			return deferred.promise;
		}

		return Promise.reject(new Error('Invalid state.'));
	}

	/**
	 * Releases an object obtained from the pool asynchronously. The returned Promise will resolve when the destroy
	 * function succeeds (or immediately if no destroy function was specified). However the promise will reject if an
	 * error is encountered during destruction or an attempt is made to release an object that was not obtained from
	 * the pool in the first place.
	 *
	 * @param {Object} obj The object to release back to the pool.
	 * @returns {Promise} A Promise that is resolved when the object is successfully destroyed.
	 */
	release(obj) {
		if (maps.origin.get(obj) !== this) {
			let err = new Error('Object was not obtained from this pool.');

			return Promise.reject(err);
		}

		let releases = maps.releases.get(this);

		if (releases.has(obj)) {
			return releases.get(obj);
		}

		let self = this;

		let promise = this._destroy(obj)
			.then(function() {
				let count = maps.count.get(self);

				count--;
				maps.count.set(self, count);

				let state = maps.state.get(self);

				if (state === states.DRAINING) {
					if (count === 0) {
						maps.transition.get(self).resolve();
						maps.transition.delete(self);
					}
				}
				else if (state === states.ACTIVE) {
					// It is likely that this fill will only resolve one acquisition request, but calling spawn
					// directly would potentially leave slots unclaimed.
					fill(self);
				}

				return Promise.resolve();
			});

		releases.set(obj, promise);

		return promise;
	}

	/**
	 * Resumes the pool allowing for continued acquisition requests. The pool may be resumed at any time, if it's
	 * already active this method is essentially a no-op. If the pool is currently draining, the draining transition is
	 * cancelled with an appropriate rejection and acquisition requests will be immediately fulfilled.
	 *
	 * @returns {Promise} A promise that is resolved when the pool is ready to accept acquisition requests.
	 */
	resume() {
		// This is a function evaluation with a more complex lookup, so we'll just save a little time here at the cost
		// of a marginal amount of temporal memory.
		let state = maps.state.get(this);

		// If the pool is currently active, then we should just return a resolved promise immediately.
		if (state === states.ACTIVE) {
			return Promise.resolve();
		}

		// If the pool is currently inactive, then we can immediately set it to active and fulfill acquisition requests
		// up to the stipulated maximum. We shouldn't need to wait for all requests to be fulfilled for the promise to
		// be resolved.
		if (state === states.INACTIVE) {
			maps.state.set(this, states.ACTIVE);

			return Promise.resolve();
		}

		if (state === states.DRAINING) {
			let transition = maps.transition.get(this);

			transition.reject(new Error('Pool resumed before completely draining.'));

			maps.transition.delete(this);
			maps.state.set(this, states.ACTIVE);

			fill(this);

			return Promise.resolve();
		}

		return Promise.reject(new Error('Invalid state.'));
	}

	/**
	 * The number of outstanding, fulfilled acquisition requests.
	 *
	 * @readonly
	 * @returns {Number}
	 */
	get count() {
		return maps.count.get(this);
	}

	/**
	 * A flag indicating whether or not the pool is currently draining.
	 *
	 * @readonly
	 * @returns {Boolean}
	 */
	get draining() {
		return maps.state.get(this) === states.DRAINING;
	}

	/**
	 * The maximum simultaneously fulfilled, outstanding acquisition requests.
	 *
	 * @returns {Number}
	 */
	get max() {
		return maps.max.get(this);
	}

	/**
	 * Sets the `max` property. Will coerce the value to a positive integer and default to `1` if coercion fails.
	 *
	 * @param {*} n The desired `max` value.
	 */
	set max(n) {
		let val = parseInt(n, 10);

		maps.max.set(this, isNaN(val) ? 1 : Math.max(val, 1));

		if (maps.state.get(this) === states.ACTIVE) {
			// When the max size is changed after instantiation it may be possible to fill remaining empty slots.
			fill(this);
		}
	}

	/**
	 * The current operational state of the pool.
	 *
	 * @returns {String}
	 */
	get state() {
		return maps.state.get(this);
	}

	/**
	 * The number of pending acquisition requests (e.g. the requests in queue that exceed the maximum simultaneously
	 * allowed by `max`).
	 *
	 * @returns {Number}
	 */
	get waiting() {
		return maps.queue.get(this).length;
	}
}


Pool.states = states;


module.exports = Pool;
