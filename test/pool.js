'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const expect = require('chai').expect;
const sinon = require('sinon');
const sinonChai = require('sinon-chai');


chai.use(chaiAsPromised);
chai.use(sinonChai);


describe('Pool', function() {
	it('should work', function() {
		let result = Promise.resolve();

		return expect(result).to.be.fulfilled;
	});

	it('should work', function() {
		let spy = sinon.spy();

		spy();

		return expect(spy).to.have.been.calledOnce;
	});
});
