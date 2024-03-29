import {IIntegrationConfig} from "../config";
import {Tracer} from "../trace/Tracer";
import {TracesLoader} from "../trace/TracesLoader";
import {IIntegration} from "./index";
import {QueryResult} from "pg";
import {Environments} from "../sharedKernel/constants";
import path from "path";
import {Trace} from "../trace/Trace";
import {OperationsType} from "./constants";
import {Connection, FieldInfo, MysqlError, Query, queryCallback, QueryOptions} from "mysql";

const shimmer = require("shimmer");
const logger = require('../logger')
const {Integrations} = require("./integrations");

interface IQueryData {
    response: any
    fields?: any
}

interface IParsedArgs {
    statement: string;
    values: any[] | undefined;
    originalCallback: queryCallback;
}

export class MysqlIntegration extends Integrations implements IIntegration {
    protected tracer: Tracer;
    protected tracesLoader: TracesLoader;
    protected readonly env: string;
    protected config: IIntegrationConfig;
    protected readonly namespace: string;
    protected _mysqlConnection: Connection;
    protected _mysql: any;
    protected _mysqlConnection2: Connection;
    protected _mysql2: any;

    constructor() {
        super()

        this.env = process.env.REBUGIT_ENV
        this.namespace = 'mysqlIntegration'

        this.counter = 0

        this.mockQuery = this.mockQuery.bind(this);
    }

    init(tracer: Tracer, tracesLoader: TracesLoader, config: IIntegrationConfig) {
        this.tracer = tracer
        this.tracesLoader = tracesLoader
        this.config = config || {}

        const mysqlConnection = this.require(path.join("mysql", "lib/Connection"));
        if (mysqlConnection) {
            this._mysqlConnection = mysqlConnection

            if (this.env === Environments.DEBUG) {
            } else {
                shimmer.wrap(mysqlConnection.prototype, 'query', this.wrapQuery())
            }
        }

        const mysql = this.require("mysql");
        if (mysql) {
            this._mysql = mysql

            if (this.env === Environments.DEBUG) {
                shimmer.wrap(mysql, 'createConnection', this.wrapMockCreateConnection())
                shimmer.wrap(mysql, 'createPool', this.wrapMockCreatePool())
            } else {
            }
        }
    }

    protected wrapQuery() {
        const integration = this
        return function (query) {
            return function (...args) {
                logger.info(`executing query wrapper`, integration.namespace)

                try {
                    const newArgs = [...args]
                    const {statement, originalCallback} = integration.parseArgs(...newArgs);

                    if (integration.isInvalidStatement(statement)) {
                        return query.apply(this, args);
                    }

                    const wrappedCallback = (err: MysqlError | null, res?: any, fields?: FieldInfo[]) => {
                        if (!err) {
                            const correlationId = integration.hashSha1(statement);
                            logger.info(`CorrelationId: ${correlationId}`, integration.namespace)

                            const data: IQueryData = {
                                response: res,
                                fields
                            }

                            const trace = new Trace({
                                operationType: OperationsType.MYSQL_QUERY,
                                correlationId,
                                data
                            })

                            integration.tracer.add(trace.trace())
                        }

                        originalCallback(err, res, fields)
                    }

                    if (args.length === 3) {
                        newArgs[2] = wrappedCallback
                    }

                    if (args.length === 2) {
                        newArgs[1] = wrappedCallback
                    }

                    // This is in the case of Pool
                    if (args.length === 1) {
                        // Depending whether is mysql (_callback) or mysql2 (onResult)
                        if (newArgs[0].onResult) {
                            newArgs[0].onResult = wrappedCallback
                        } else {
                            newArgs[0]._callback = wrappedCallback
                        }
                    }

                    return query.call(this, ...newArgs);
                } catch (error) {
                    logger.error(error, integration.namespace)
                    return query.apply(this, args);
                }
            };
        }
    }

    protected mockQuery(...args) {
        logger.info(`executing query mock wrapper`, this.namespace)

        const newArgs = [...args]
        const {statement, originalCallback} = this.parseArgs(...newArgs);

        if (this.isInvalidStatement(statement)) {
            let mockQuery = () => {
                originalCallback(null)
            }

            /**
             * Sequelize check the version of the database, if this value is empty it will throw an error
             */
            if (statement.includes("SELECT VERSION()")) {
                mockQuery = () => {
                    originalCallback(null, [{version: ''}])
                }
            }

            return mockQuery.call(this)
        }

        const correlationId = this.hashSha1(statement);
        logger.info(`CorrelationId: ${correlationId}`, this.namespace)

        const data = this.tracesLoader.get<IQueryData>(correlationId)

        const wrappedCallback = () => {
            originalCallback(null, data.response, data.fields)
        }

        if (args.length === 3) {
            newArgs[2] = wrappedCallback
        } else {
            newArgs[1] = wrappedCallback
        }

        const mockQueryWithCallback = () => {
            wrappedCallback()
        }

        return mockQueryWithCallback.call(this)
    }

    protected mockConnect(...args) {
        if (typeof args[0] === 'function') {
            args[0](null)
        } else {
            args[1](null)
        }
    }

    protected mockEnd(...args) {
        if (typeof args[0] === 'function') {
            args[0](null)
        } else {
            args[1](null)
        }
    }

    protected mockOnce(event: string | symbol, listener: (...args: any[]) => void): void {
        if (event === 'connect') {
            listener()
        }
    }

    protected wrapMockCreateConnection() {
        const integration = this
        return function (createConnection) {
            return function (...args) {
                logger.info(`executing createConnection mock wrapper`, integration.namespace)

                const connection = createConnection(...args)
                connection.connect = integration.mockConnect
                connection.end = integration.mockEnd
                connection.query = integration.mockQuery
                connection.once = integration.mockOnce
                connection.state = 'connected'
                connection.threadId = 1

                if (integration._mysql2) {
                    /**
                     * This is an extreme hack for mysql2, mysql2 will create a connection inside
                     * the createConnection method; in debug mode will throw an error, however
                     * the whole mocking operation will be successful.
                     * Mocking this method will prevent 'ECONNREFUSED' error from leaking out.
                     */
                    connection._notifyError = () => {
                    }
                    connection.execute = integration.mockQuery
                }

                return connection
            };
        }
    }

    protected wrapMockCreatePool() {
        const integration = this
        return function (createPool) {
            return function (...args) {
                logger.info(`executing createPool mock wrapper`, integration.namespace)

                const pool = createPool(...args)
                pool.connect = integration.mockConnect
                pool.end = integration.mockEnd
                pool.query = integration.mockQuery
                pool.once = integration.mockOnce
                pool.state = 'connected'
                pool.release = function () {
                }
                pool.getConnection = function (...args) {
                    args[0](null, pool)
                }

                return pool
            };
        }
    }


    private parseArgs(...newArgs: any[]): IParsedArgs {
        const rawQueryOrOptions: string | QueryOptions | Query = newArgs[0]
        let statement: string;
        let callback: queryCallback;
        let values: any[];
        const lastArgument = newArgs[2];

        /**
         * If there are three arguments:
         * (options: string | QueryOptions, values: any, callback?: queryCallback)
         */
        if (newArgs.length === 3) {
            values = newArgs[1]
            if (typeof rawQueryOrOptions === 'string') {
                statement = this.replaceSqlQueryArgs(rawQueryOrOptions as string, values);
            }

            if (typeof rawQueryOrOptions === 'object') {
                statement = this.replaceSqlQueryArgs((rawQueryOrOptions as QueryOptions).sql, values)
            }

            callback = lastArgument;
        }

        /**
         * if there are two arguments:
         * (options: string | QueryOptions, callback?: queryCallback)
         */
        if (newArgs.length === 2) {
            if (typeof rawQueryOrOptions === 'string') {
                statement = rawQueryOrOptions
            } else {
                const {values, sql} = rawQueryOrOptions as QueryOptions
                statement = this.replaceSqlQueryArgs(sql, values)
            }

            callback = newArgs[1]
        }

        /**
         * if there is only one argument: usually if we are implementing a Pool
         * _callback is from mysql
         * onResult is from mysql2
         * (query: Query)
         */
        if (newArgs.length === 1) {
            // @ts-ignore
            const {values, sql, _callback, onResult} = rawQueryOrOptions as Query
            statement = this.replaceSqlQueryArgs(sql, values)
            if (onResult) {
                callback = onResult
            } else {
                callback = _callback
            }
        }

        logger.info(`query: ${statement}`, this.namespace)

        return {
            statement,
            values,
            originalCallback: callback
        }
    }

    /**
     * Replace all query parameters
     * Ex: SELECT 1 + ? AS result, [4] => SELECT 1 + 5 AS result
     */
    protected replaceSqlQueryArgs(statement: string, values: any[]): string {
        return this._mysql.format(statement, values)
    }

    private getExtraFieldsFromRes(res: QueryResult, data: any) {
        if (this.config.extraFields) {
            this.config.extraFields.forEach(field => {
                data[field] = res[field]
            })
        }
    }

    /**
     * this will blacklist useless ORM extra statements
     */
    private isInvalidStatement(statement: string): boolean {
        const index = blackListStatements
            .findIndex(element => statement.toUpperCase().includes(element.toUpperCase()))
        return index >= 0;
    }

    end() {
        if (this.env === Environments.DEBUG) {
            if (this._mysql) {
                shimmer.unwrap(this._mysql, 'createConnection')
                shimmer.unwrap(this._mysql, 'createPool')
            }
        } else {
            if (this._mysqlConnection) {
                // @ts-ignore
                shimmer.unwrap(this._mysqlConnection.prototype, 'query')
            }
        }
    }
}

/**
 * Group of queries that we don't want to store, mostly ORM internal queries
 */
const blackListStatements: string[] = [
    'SET time_zone = \'+00:00\'',
    'SELECT VERSION()',
]