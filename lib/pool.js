'use strict';

const PriorityQueue = require('js-priority-queue');


let maps = {
	count: new WeakMap(),
	drain: new WeakMap(),
	max: new WeakMap(),
	origin: new WeakMap(),
	queue: new WeakMap()
};


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
 * Attempts to fill any available pool slots and spawn appropriate objects.
 *
 * @private
 */
function fill() {
	let queue = maps.queue.get(this);

	// While the current count is less than the allotted maximum and there are outstanding acquisition
	// requests, attempt to fill the available space.
	while (this.count < this.max && this.waiting > 0) {
		spawn.call(this, queue.dequeue());
	}
}


/**
 *
 */
function noop() {}


/**
 *
 * @param {Number} a
 * @param {Number} b
 * @returns {Number}
 */
function queueComparator(a, b) {
	return b.priority - a.priority;
}


/**
 * Normalizes the spawning process of the pool elements and appropriately tracks the number of active,
 * fulfilled requests.
 *
 * @private
 * @param {Object} deferred An internal "deferred" object that can be used to reject or resolve the original
 *     acquisition requests.
 * @returns {Promise} A promise that is resolved when the pool object is successfully created.
 */
function spawn(deferred) {
	let self = this;

	// Make sure to increase the counter. If there is an error during creation we'll just decrease the counter
	// again. But if the object takes a particularly long time to create we don't want any other acquisition
	// requests cutting in line.
	let count = maps.count.get(this);

	count++;
	maps.count.set(this, count);

	return this._create()
		.then(function(obj) {
			// When the object is successfully created, mark it as originating from this pool.
			maps.origin.set(obj, self);

			// Resolve the original acquisition request.
			deferred.resolve(obj);
		})
		.catch(function(err) {
			// There was an error during object creation, so reject the original acquisition request.
			deferred.reject(err);

			// Decrease the count of the pool to "undo" the pre-emptive increment.
			count--;
			maps.count.set(self, count);
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
		// An internal count of the currently fulfilled acquisition requests.
		maps.count.set(this, 0);
		// An internal reference to keep track of the maximum size of the pool.
		maps.max.set(this, Infinity);
		// An internal priority queue for keeping track of acquisition requests.
		maps.queue.set(this, new PriorityQueue({
			comparator: queueComparator
		}));

		// A asynchronous/synchronous normalized version of the supplied create option.
		this._create = promisify(options.create || Slot.create);
		// A asynchronous/synchronous normalized version of the supplied destroy option.
		this._destroy = promisify(options.destroy || noop);

		this.max = options.max;
	}

	/**
	 * Acquires a new object from the pool asynchronously. The returned Promise will resolve when there is a free slot
	 * available in the pool. However the promise will be rejected if any errors are encountered during object creation
	 * (using the configured options.create function) or if an attempt is made to acquire a new pool object when the
	 * pool has already been marked for draining.
	 *
	 * @param {Number|String} [priority=1] The priority with which to obtain a new element from the pool.
	 * @returns {Promise} A promise that is resolved when the object is successfully created.
	 */
	acquire(priority = 1) {
		let self = this;

		// Check to see if the pool is draining. If so we can't obtain a new object, so reject the promise.
		if (this.draining) {
			let err = new Error('Pool is draining');

			return Promise.reject(err);
		}

		return new Promise(function(resolve, reject) {
			let queue = maps.queue.get(self);

			// Queue a new "deferred" with the specified priority.
			queue.queue({
				resolve: resolve,
				reject: reject,
				priority: isNaN(priority) ? 1 : priority
			});

			// If the current count is less than the maximum size we can immediately dequeue and process the
			// acquisition request.
			if (self.count < self.max) {
				spawn.call(self, queue.dequeue());
			}
		});
	}

	drain() {
		let self = this;

		return new Promise(function(resolve) {
			maps.drain.set(self, resolve);
		});
	}

	/**
	 * Releases an object obtained from the pool asynchronously. The returned Promise will resolve when the destroy
	 * function succeeds (or immediately if no destroy function was specified). However the promise will reject if an
	 * error is encountered during destruction or an attempt is made to release an object that was not obtained from
	 * the pool in the first place.
	 *
	 * @param {Object} obj The object to release back to the pool.
	 * @returns {Promise} A promise that is resolved when the object is successfully destroyed.
	 */
	release(obj) {
		let self = this;

		if (maps.origin.get(obj) !== this) {
			let err = new Error('Object was not obtained from this pool');

			return Promise.reject(err);
		}

		return this._destroy(obj)
			.then(function() {
				let count = maps.count.get(self);

				count--;
				maps.count.set(self, count);
				maps.origin.delete(obj);

				if (count === 0 && maps.drain.has(self)) {
					maps.drain.get(self)();
				}
				else {
					// It is likely that this fill will only resolve one acquisition request, but calling spawn
					// directly would potentially leave slots unclaimed.
					fill.call(self);
				}
			});
	}

	get count() {
		return maps.count.get(this);
	}

	get draining() {
		return maps.drain.has(this);
	}

	get max() {
		return maps.max.get(this);
	}

	set max(n) {
		let val = parseInt(n, 10);

		maps.max.set(this, isNaN(val) ? 1 : Math.max(val, 1));

		// When the max size is changed after instantiation it may be possible to fill remaining empty slots. Attempt
		// to process this.
		fill.call(this);
	}

	get waiting() {
		return maps.queue.get(this).length;
	}
}


module.exports = Pool;
