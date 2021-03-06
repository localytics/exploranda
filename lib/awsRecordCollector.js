const _ = require('lodash');
const async = require('async');
var AWS = require('aws-sdk');

function paramsToParamArray(sourceSchema, params) {
  const individualCallParams = [];
  _.each(sourceSchema.requiredParams, (paramDescription, paramName) => {
    const detectArray = paramDescription.detectArray || _.isArray;
    let param = params[paramName];
    if (!param) {
      throw new Error(`Problem creating individual call params for ${sourceSchema.name}. looking for ${paramName}, but did not find it in params ${JSON.stringify(params)}`);
    }
    // logically, we are only asking for one group of resources,
    // but the number of resources in the group happens to be larger
    // than the maximum we are allowed to request from AWS at one
    // time.
    const needSplitForMax = !detectArray(param) && param.length > paramDescription.max;
    param = needSplitForMax ? _.chunk(params[paramName], paramDescription.max) : params[paramName];
    if (detectArray(param) || needSplitForMax) {
      if (individualCallParams.length !== 0 && param.length != individualCallParams.length) {
        throw new Error(`Problem constructing parameters for schema ${sourceSchema.name}: when passing multiple arrays of parameters, they must be the same length ${JSON.stringify(params)}`);
      }
      _.each(param, (paramValue, index) => {
        individualCallParams[index] = _.assign({},
          sourceSchema.params,
          individualCallParams[index] || params,
          {[paramName]: paramValue}
        );
      });
    }
  });
  _.each(sourceSchema.requiredParams, (paramDescription, paramName) => {
    const detectArray = paramDescription.detectArray || _.isArray;
    const param = params[paramName];
    const needSplitForMax = !detectArray(param) && param.length > paramDescription.max;
    if (!detectArray(param) && !needSplitForMax) {
      if (individualCallParams.length === 0) {
        individualCallParams.push(_.assign({}, sourceSchema.params, params));
      }
      _.each(individualCallParams, (icParam) => {
        icParam[paramName] = _.cloneDeep(param);
      });
    }
  });
  if (individualCallParams.length === 0) {
    if (_.keys(sourceSchema.requiredParams).length !== 0) {
      return [];
    }
    individualCallParams.push(_.assign({}, sourceSchema.params, params));
  }
  return individualCallParams;
}

function fetchAndMergeAllResults(sourceSchema, paramSet, callback) {
  const constructorArgs = _.merge({},
    paramSet.awsConfig,
    sourceSchema.namespaceDetails.constructorArgs
  );
  delete paramSet.awsConfig;
  const api = new AWS[sourceSchema.namespaceDetails.name](constructorArgs);
  let currentParams = paramSet;
  function fetchAndMergeAll(collector, err, res) {
    if (err && _.isFunction(sourceSchema.onError)) {
       const errAndRes = sourceSchema.onError(err, res);
      err = errAndRes.err;
      res = errAndRes.res;
    }
    if (err) {
      const s = `Error fetching results for schema ${sourceSchema.name} with params ${JSON.stringify(currentParams)} Error ${err}`;
      throw new Error(s);
    }
    let results;
    if (_.isFunction(sourceSchema.value.path)) {
      results = sourceSchema.value.path(res);
    } else {
      results = _.get(res, sourceSchema.value.path);
    }
    if (!results) {
      const s = `${sourceSchema.name} specifies path as ${sourceSchema.value.path} but that path is not present on ${JSON.stringify(res)}`
      throw new Error(s);
    }
    collector = collector ? (sourceSchema.mergeOperator || _.concat)(collector, results) : results;
    if (_.get(res, sourceSchema.incompleteIndicator)) {
      currentParams = sourceSchema.nextBatchParamConstructor(_.cloneDeep(currentParams), _.cloneDeep(res));
      return async.retry(
        {times: 10, interval: (t) => 1000 * Math.random() * t}, 
        (cb) => api[sourceSchema.apiMethod](currentParams, cb),
        _.partial(fetchAndMergeAll, collector)
      );
    } else {
      return callback(err, collector);
    }
  }
  return async.retry(
    {times: 10, interval: (t) => 1000 * Math.random() * t}, 
    (cb) => api[sourceSchema.apiMethod](currentParams, cb),
    _.partial(fetchAndMergeAll, null)
  );
}

// request a specific record or series of records based on a source
// schema and complete set of parameters.
function execRecordRequest(sourceSchema, params, callback) {
  const paramsArray = paramsToParamArray(sourceSchema, params);
  return async.parallel(_.map(paramsArray, (paramSet) => {
    return function(parallelCallback) {
      return fetchAndMergeAllResults(sourceSchema, paramSet, parallelCallback);
    };
  }), (e, r) => {callback(e, (sourceSchema.mergeIndividual || _.flatten)(r));});
}

// recursive descent to get the records identified by the sourceSchema and the params
function lookUpRecords(sourceSchema, params, callback) {
  if (!sourceSchema) {
    throw new Error('sourceSchema must be defined')
  }
  const requiredParams = _.get(sourceSchema, 'requiredParams');
  // base case--there are no required params needed or else we've already
  // gotten what we need--send the request to get the results.
  if (!requiredParams || sufficientParams(sourceSchema, params)) {
    return execRecordRequest(sourceSchema, _.cloneDeep(params || {}), callback);
  } else {
    // recursion case--the parameters we need for this request require that we look up
    // the records that coorespond to _other_ sourceSchemas and parameters. In this case,
    // create a map like: 
    // 
    //   {
    //     parameterName: (async.js standard callback function) to get the data
    //     ...
    //   }
    //
    // and pass that map to [async.auto](http://caolan.github.io/async/docs.html#auto),
    // which is a perfect expression of the Tao of JavaScript.
    return async.auto(_.reduce(sourceSchema.requiredParams, (collector, {defaultSource}, paramName) => {
      if (!defaultSource) {
        throw new Error(`No acceptable value provided for the ${paramName} parameter in the ${sourceSchema.name} schema. An acceptable value must be an object with a "value" member containing the literal value, or a "source" member containing the name of the source`);
      }
      collector[paramName] = _.partial(lookUpRecords, defaultSource, _.merge(_.cloneDeep(defaultSource.params), {awsConfig: _.cloneDeep(_.get(params, 'awsConfig'))}));
      return collector;
    }, {}), 
      // This callback is executed after the `async.auto` call completes. `res` is a map with the
      // same keys as the map we passed in to `auto`, but the values are the results of the
      // asynchronous calls.
      (err, res) => {
        // Since the `res` consisted of the parameters we needed, we just merge it with the params
        // we started with and try the lookup again
        return lookUpRecords(sourceSchema, _.merge({}, params, res), callback);
      }
    );
  }
}

function sufficientParams(sourceSchema, params) {
  return _.reduce(sourceSchema.requiredParams, (collector, unused, paramName) => {
    return collector && _.has(params, paramName);
  }, true);
}

module.exports = {
  lookUpRecords: (sourceSchema, params, callback) => {
    return lookUpRecords(sourceSchema, params, (e, r) => {
      if (e) {return callback(e);}
      const results = sourceSchema.value.sortBy ? _.sortBy(r, sourceSchema.value.sortBy) : r;
      return callback(e, results);
    });
  },
  sufficientParams
};
