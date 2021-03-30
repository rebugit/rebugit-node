const {Http} = require('rbi-nodejs-agent/dist/integrations');
const {Tracer} = require('rbi-nodejs-agent/dist/trace/Tracer');
const {TracesLoader} = require('rbi-nodejs-agent/dist/trace/TracesLoader');
const {
    requestWithHttp,
    requestWithSuperagent,
    requestWithAxios,
    requestWithGot,
    clearEnvironmentVariables,
    RESPONSE_BODY,
    REQUEST_BASE_URL,
    PATH
} = require("./utils");
const {traces} = require('./data')
const expect = require('expect')
const axios = require("axios");

/**
 * Jest does not preserve symlink making those type of tests fails
 * By running normal nodejs function the tests can run correctly
 */
async function httpIntegrationProductionMode() {
    let httpIntegration;

    function beforeEach(name) {
        console.log(`============= TESTING: should ${name} ===================`)
        process.env.REBUGIT_LOG = 'ALL'
        const tracer = new Tracer()
        const tracesLoader = new TracesLoader()
        httpIntegration = new Http()
        httpIntegration.init(tracer, tracesLoader, {})
        return {tracer}
    }

    function afterEach() {
        clearEnvironmentVariables()
        httpIntegration.end()
        console.log(`\n\n`)
    }

    async function httpIntegrationTestAxios() {
        const {tracer} = beforeEach('correctly integrate with axios');

        const axiosResponse = await requestWithAxios(true);
        console.log(axiosResponse.data);

        expect(tracer.traces.length).toBe(1)
        expect(tracer.traces[0].correlationId).toBe('GET_/todos/1_1')
        expect(tracer.traces[0].operationType).toBe('RESPONSE')
        expect(tracer.traces[0].data).toBeDefined()
        expect(axiosResponse.data).toEqual(RESPONSE_BODY)

        afterEach()
    }

    async function httpIntegrationTestHttp() {
        const {tracer} = beforeEach('correctly integrate with native http module');
        const response = await requestWithHttp(false);

        expect(tracer.traces.length).toBe(1)
        expect(tracer.traces[0].correlationId).toBe('GET_/todos/1_1')
        expect(tracer.traces[0].operationType).toBe('RESPONSE')
        expect(tracer.traces[0].data).toBeDefined()
        expect(response).toEqual(RESPONSE_BODY)

        afterEach()
    }

    async function httpIntegrationTestSuperagent() {
        const {tracer} = beforeEach('correctly integrate with superagent module');
        const body = await requestWithSuperagent();

        expect(tracer.traces.length).toBe(1)
        expect(tracer.traces[0].correlationId).toBe('GET_/todos/1_1')
        expect(tracer.traces[0].operationType).toBe('RESPONSE')
        expect(tracer.traces[0].data).toBeDefined()
        expect(body).toEqual(RESPONSE_BODY)

        afterEach()
    }

    async function httpIntegrationTestGot() {
        const {tracer} = beforeEach('correctly integrate with got module');
        const body = await requestWithGot();

        expect(tracer.traces.length).toBe(1)
        expect(tracer.traces[0].correlationId).toBe('GET_/todos/1_1')
        expect(tracer.traces[0].operationType).toBe('RESPONSE')
        expect(tracer.traces[0].data).toBeDefined()
        expect(JSON.parse(body)).toEqual(RESPONSE_BODY)

        afterEach()
    }


    async function httpIntegrationTestMultipleRequestWithSamePath() {
        const {tracer} = beforeEach('correctly integrate with native http module and make parallel request');
        await Promise.all([
            await requestWithHttp(false),
            await requestWithHttp(false),
            await requestWithHttp(false)
        ])

        expect(tracer.traces.length).toBe(3)
        expect(tracer.traces[0].correlationId).toBe('GET_/todos/1_1')
        expect(tracer.traces[1].correlationId).toBe('GET_/todos/1_2')
        expect(tracer.traces[2].correlationId).toBe('GET_/todos/1_3')


        afterEach()
    }

    await httpIntegrationTestAxios()
    await httpIntegrationTestHttp()
    await httpIntegrationTestSuperagent()
    await httpIntegrationTestGot()
    await httpIntegrationTestMultipleRequestWithSamePath()
}

async function httpIntegrationDebugMode() {
    let httpIntegration;

    function beforeEach(name) {
        console.log(`============= TESTING: should ${name} ===================`)
        process.env.REBUGIT_LOG = 'ALL'
        process.env.REBUGIT_ENV = 'debug'
        const tracer = new Tracer()
        const tracesLoader = new TracesLoader()
        tracesLoader.load(traces)
        httpIntegration = new Http()
        httpIntegration.init(tracer, tracesLoader, {})
        return {tracer}
    }

    function afterEach() {
        clearEnvironmentVariables()
        httpIntegration.end()
        console.log(`\n\n`)
    }

    async function httpIntegrationTestAxios() {
        beforeEach('correctly inject data and mock axios');

        axios.interceptors.request.use((config) => {
            expect(config.url).toBe(`https://${REQUEST_BASE_URL}/${PATH}`)
            return config;
        });

        const axiosResponse = await requestWithAxios(true);
        expect(axiosResponse.data).toEqual(RESPONSE_BODY)

        afterEach()
    }

    async function httpIntegrationTestWithSuperagent() {
        beforeEach('correctly inject data and mock request module');

        const body = await requestWithSuperagent();
        expect(body).toEqual(RESPONSE_BODY)

        afterEach()
    }

    async function httpIntegrationTestWithHttp() {
        beforeEach('correctly inject data and mock http native module');

        const httpResponse = await requestWithHttp();
        expect(httpResponse).toEqual(RESPONSE_BODY)

        afterEach()
    }

    await httpIntegrationTestAxios()
    await httpIntegrationTestWithSuperagent()
    await httpIntegrationTestWithHttp()
}

async function runTests() {
    await httpIntegrationProductionMode()
    await httpIntegrationDebugMode()
    console.log("======DONE======")
}

runTests().then().catch(e => {
    console.log(e.message)
    process.exit(1)
})
