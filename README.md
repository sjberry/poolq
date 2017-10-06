# poolq

**poolq** was motivated by the need for simple, granular flow control over queues of work.
**poolq** provides methods to gracefully control process management and shape resource consumption while offering additional sources of informative metrics.
The primary design goal is a slim and maintainable codebase to provide a potential basis for more complex application middleware.

It is important to note that **poolq** `Pool` instances are deliberately limited in scope to in-process memory.
If you should need task pooling across processes (e.g. clusters, forks, or IPC) then you will need to make use of a data store such as Redis.
Cross-process pooling is not currently in the feature road map.
 
## Installation

Installation is typical and straightforward with some caveats.

```
npm install poolq
```

You will need a version of NodeJS that supports the `WeakMap` data structure inherently.
**poolq** leverages weak maps internally and makes no effort to shim for backwards compatibility.

The test cases are partially written in ES2017 with async/await syntax.
The library itself is written in ES6 and does not transpile before publishing.


## Usage

**poolq** operates around the concept of `Pool` instances issuing `Slot` instance work slots via acquisition requests.
Concurrency is controlled by way of stipulating a maximum number of parallel work slots. Slots will be issued up to, but not exceeding this maximum.
When a work slot's task has been completed the `Slot` instance itself **must** be returned to the origin `Pool` to permit subsequent acquisitions.

```js
'use strict';

const Pool = require('poolq');


// Create a new `Pool` instance.
let pool = new Pool();

// Acquire a new work slot, process whatever work needs to happen and return the slot to the pool.
pool.acquire()
    .then(function(slot) {
    	// ...
    	
    	pool.release(slot);
    });
```

By default a `Pool` instance will have an unbounded maximum number of concurrent work slots.
This can be limited with the `max` option on instantiation or subsequently dynamically updated.

```js
let pool = new Pool({
    max: 5
});
```

### Instance Methods

>`.acquire()`

Asynchronously obtains a new work slot from the pool.
The resulting `Promise` is resolved when the requested work slot is issued by the pool or rejected when an error is encountered.

**Arguments:** `(none)`

**Returns:** `Promise` A promise resolved with the work slot instance when it is successfully issued.

**Example:**

```js
let pool = new Pool();

pool.acquire()
    .then(function(slot) {
    	// ...
    })
    .catch(function(err) {
    	// ...
    });
```

>`.drain()`

Marks the pool for draining.
Outstanding work slots that have been issued will not be automatically reclaimed, but additional requests for work slots via `.acquire()` will be rejected.
The resulting `Promise` is resolved when the pool has completely drained (i.e. `pool.count === 0`).
While the pool is still draining, subsequent calls to `.drain()` will return the same `Promise` instance.

**Arguments:** `(none)`

**Returns:** `Promise` A promise resolved with no arguments when the pool is completely drained.

**Example:**

```js
let pool = new Pool();

pool.acquire()
    .then(function(slot) {
    	setTimeout(function() {
    		pool.release(slot);
    	}, 1500);
    });

pool.drain()
    .then(function() {
    	console.log('drained');
    });
```

>`.release(slot)`

Releases an acquired work slot back to the pool.
This should always be required to maintain a minimal memory footprint.
If a concurrency cap is set with `max` this is also required to process subsequent requests for work slots.
The `slot` argument **must** have originated from the `Pool` instance or the returned `Promise` will be rejected.

**Arguments:**

`slot` _Slot_ The acquired work slot instance previously obtained from the `Pool`.

**Returns:** `Promise` A promise resolved with no arguments when the work slot is successfully released.

**Example:**

```js
let pool = new Pool();

pool.acquire()
    .then(function(slot) {
    	pool.release(slot);
    });
```

>`.resume()`

Resumes a pool enabling or re-enabling work slot acquisition.
If the pool is currently draining the existing drain transition will be rejected and work slot issuance will immediately resume.

**Arguments:** `(none)`

**Returns:** `Promise` A promise resolved with no arguments when the pool is successfully resumed.

**Example:**

```js
let pool = new Pool();

pool.drain()
    .then(function() {
    	// ...
    	
    	pool.resume();
    });
```

### Properties

>**count** _Number_ _readonly_ The current number of issued work slots.

A work slot is requested with `.acquire()` but is not issued until the `Pool` instance has suitable space available.
The `count` property indicates how many slots are currently issued but not yet returned.

>**draining** _Boolean_ _readonly_ A flag indicating whether or not the pool is currently draining.

A `Pool` instance can be drained with the `.drain()` method.
Doing so will prevent additional work slots from being issued.
This property indicates whether the `Pool` instance is currently draining.

>**max** _Number_ The maximum number of concurrent active work slots.

While the number of _pending_ work slots is ostensibly unbounded, there is an established limit on maximum number of concurrent slots that will be resolved via `.acquire()`.
The `max` property can be set dynamically on an active `Pool` instance and work slots will be issued as appropriate.
Reducing the `max` below the current `count` will not affect the slots already issued but will prevent additional slots from being issued until enough slots have been returned such that `count < max`.
 
>**waiting** _Number_ _readonly_ The current number of pending, requested work slots.

When the number of requested work slots exceeds the concurrency stipulated by the `max` property they are relegated to a queue.
The `waiting` property indicates the number of queued work slot acquisition requests.


## Examples

There are some rudimentary examples composed in the `examples/` sub-folder for reference.
