'use strict';

const Pool = require('poolq').Pool;


let pool = new Pool({
	max: 2,
	create: function() {
		if (Math.random() > 0.75) {
			throw new Error('Error probability exceeded');
		}

		return {
			date: new Date()
		};
	}
});

setInterval(function() {
	console.log(pool.count + '/' + pool.max + ' (' + pool.waiting + ' waiting)');
}, 500);

for (let i = 0; i < 15; i++) {
	pool.acquire()
		.then(function(obj) {
			let expiration = (5000 * Math.random() + 3000) | 0;

			console.log(obj, expiration + 'ms');

			setTimeout(function() {
				pool.release(obj);
			}, expiration);
		})
		.catch(function(err) {
			console.log(err);
		});
}

setTimeout(function() {
	pool.max = 10;
}, 4000);

setTimeout(function() {
	pool.max = 5;
}, 10000);


process.stdin.resume();
