'use strict';

const EventEmitter = require('events').EventEmitter;

const PriorityQueue = require('js-priority-queue');
const Promise = require('bluebird');
const noop = require('node-noop').noop;


let emitters = new WeakMap();


/**
 * Default creation function for a pool.
 *
 * @private
 * @returns {Slot} A new slot instance that can subsequently be returned to the pool.
 */
function defaultCreator() {
	return new Slot();
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
	constructor(options) {
		let self = this;

		options = options || {};

		// The count of the currently fulfilled acquisition requests.
		let count = 0;
		// A flag to indicate whether the pool instance has been marked for draining/destruction.
		let draining = false;
		// An internal variable to keep track of the maximum size of the pool.
		let max;

		// A asynchronous/synchronous normalized version of the supplied create option.
		const create = Promise.method(options.create || defaultCreator);
		// A asynchronous/synchronous normalized version of the supplied destroy option.
		const destroy = Promise.method(options.destroy || noop);
		// An internal event emitter to marshal the allocation and deallocation of pool slots.
		const emitter = new EventEmitter();
		// An internal tracker that catches attempts to release inappropriate objects to the pool.
		const objects = new WeakMap();
		// An internal priority queue for keeping track of acquisition requests.
		const queue = new PriorityQueue({
			comparator: function(a, b) {
				return b.priority - a.priority;
			}
		});

		// Set the instance emitter in the tracking index so that it can be referenced in member methods.
		emitters.set(this, emitter);

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
			// Make sure to increase the counter. If there is an error during creation we'll just decrease the counter
			// again. But if the object takes a particularly long time to create we don't want any other acquisition
			// requests cutting in line.
			count++;

			return create()
				.then(function(obj) {
					// When the object is successfully created, mark it as originating from this pool.
					objects.set(obj, true);

					// Resolve the original acquisition request.
					deferred.resolve(obj);
				})
				.catch(function(err) {
					// There was an error during object creation, so reject the original acquisition request.
					deferred.reject(err);

					// Decrease the count of the pool to "undo" the pre-emptive increment.
					count--;
				});
		}

		/**
		 * Attempts to fill any available pool slots and spawn appropriate objects.
		 *
		 * @private
		 */
		function fill() {
			// While the current count is less than the allotted maximum and there are outstanding acquisition
			// requests, attempt to fill the available space.
			while (count < self.max && queue.length > 0) {
				spawn(queue.dequeue());
			}
		}

		// When the max size is changed after instantiation it may be possible to fill remaining empty slots. Attempt
		// to process this.
		emitter.on('resize', fill);

		// When an acquisition request is made, attempt to create and return a new object.
		emitter.on('acquire', function(priority, resolve, reject) {
			// Queue a new "deferred" with the specified priority.
			queue.queue({
				resolve: resolve,
				reject: reject,
				priority: priority
			});

			// If the current count is less than the maximum size we can immediately dequeue and process the
			// acquisition request.
			if (count < self.max) {
				spawn(queue.dequeue());
			}
		});

		// When an object is released back to the pool, attempt to destroy it, reduce the count of the outstanding,
		// fulfilled requests, and attempt to refill to the maximum allowable size.
		emitter.on('release', function(obj, resolve, reject) {
			if (!objects.get(obj)) {
				reject(new Error('Object was not obtained from this pool'));
			}
			else {
				destroy(obj)
					.then(function() {
						objects.delete(obj);
						resolve();

						count--;

						// It is likely that this fill will only resolve one acquisition request, but calling spawn
						// directly would potentially leave slots unclaimed.
						fill();
					})
					.catch(function(err) {
						reject(err);
					});
			}
		});

		Object.defineProperties(this, {
			count: {
				enumerable: true,
				get: function() {
					return count;
				}
			},

			draining: {
				enumerable: true,
				get: function() {
					return draining;
				}
			},

			max: {
				enumerable: true,
				get: function() {
					return max;
				},
				set: function(n) {
					let val = parseInt(n, 10);

					max = isNaN(val) ? 1 : Math.max(val, 1);

					emitter.emit('resize');
				}
			},

			waiting: {
				enumerable: true,
				get: function() {
					return queue.length;
				}
			}
		});

		//this.idleTimeoutMillis = options.idleTimeoutMillis || 30000;
		//this.reapInterval = options.reapInterval || 1000;
		//this.recycle = options.recycle === true;
		this.max = options.max;
		this.drain = function() {
			draining = true;
		};
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
	acquire(priority) {
		let self = this;

		return new Promise(function(resolve, reject) {
			// Check to see if the pool is draining. If so we can't obtain a new object, so reject the promise.
			if (self.draining) {
				reject(new Error('Pool is draining'));
			}
			else {
				let emitter = emitters.get(self);

				emitter.emit('acquire', priority || 1, resolve, reject);
			}
		});
	}

	/**
	 * Releases an object obtained from the pool asynchronously. The returned Promise will resolve when the destroy
	 * function succeeds (or immediately if no destroy function was specified). However the promise will reject if an
	 * error is encountered during destruction or an attempt is made to release an object that was not obtained from
	 * the pool in the first place.
	 *
	 * @param {Object} object The object to release back to the pool.
	 * @returns {Promise} A promise that is resolved when the object is successfully destroyed.
	 */
	release(object) {
		let self = this;

		return new Promise(function(resolve, reject) {
			let emitter = emitters.get(self);

			emitter.emit('release', object, resolve, reject);
		});
	}
}


module.exports = Pool;
