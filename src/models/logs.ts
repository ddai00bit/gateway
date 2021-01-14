import config from 'config';
import fs from 'fs';
import path from 'path';
import {verbose, Database as SQLiteDatabase} from 'sqlite3';
import * as Constants from '../constants';
import UserProfile from '../user-profile';

const AddonManager = require('../addon-manager');

const sqlite3 = verbose();

const METRICS_NUMBER = 'metricsNumber';
const METRICS_BOOLEAN = 'metricsBoolean';
const METRICS_OTHER = 'metricsOther';

class Logs {
  private db: SQLiteDatabase|null;

  private idToDescr: Record<number, any>;

  private descrToId: Record<string, number>;

  private _onPropertyChanged: (property: any) => void;

  private _clearOldMetrics: () => Promise<void>;

  private clearOldMetricsInterval: NodeJS.Timeout;

  constructor() {
    this.db = null;
    this.idToDescr = {};
    this.descrToId = {};
    this._onPropertyChanged = this.onPropertyChanged.bind(this);
    this._clearOldMetrics = this.clearOldMetrics.bind(this);

    AddonManager.on(Constants.PROPERTY_CHANGED, this._onPropertyChanged);

    // Clear out old metrics every hour
    this.clearOldMetricsInterval = setInterval(this._clearOldMetrics, 60 * 60 * 1000);
  }

  clear(): Promise<any[]> {
    this.idToDescr = {};
    this.descrToId = {};
    return Promise.all([
      METRICS_NUMBER,
      METRICS_BOOLEAN,
      METRICS_OTHER,
      'metricIds',
    ].map((table) => {
      return this.run(`DELETE FROM ${table}`, []);
    }));
  }

  close(): void {
    if (this.db) {
      this.db!.close();
      this.db = null;
    }

    AddonManager.removeListener(Constants.PROPERTY_CHANGED,
                                this._onPropertyChanged);
    clearInterval(this.clearOldMetricsInterval);
  }

  open(): void {
    // Get all things, create table if not exists
    // If the database is already open, just return.
    if (this.db) {
      return;
    }

    const filename = path.join(UserProfile.logDir, 'logs.sqlite3');

    let exists = fs.existsSync(filename);
    const removeBeforeOpen = config.get('database.removeBeforeOpen');
    if (exists && removeBeforeOpen) {
      fs.unlinkSync(filename);
      exists = false;
    }

    console.log(exists ? 'Opening' : 'Creating', 'database:', filename);
    // Open database or create it if it doesn't exist
    this.db = new sqlite3.Database(filename);

    // Set a timeout in case the database is locked. 10 seconds is a bit long,
    // but it's better than crashing.
    this.db.configure('busyTimeout', 10000);

    this.createTables().then(() => {
      this.loadKnownMetrics();
    });
  }

  createTables(): Promise<any[]> {
    return Promise.all([
      this.createMetricTable(METRICS_NUMBER, typeof 0),
      this.createMetricTable(METRICS_BOOLEAN, typeof false),
      this.createMetricTable(METRICS_OTHER, typeof {}),
      this.createIdTable(),
    ]);
  }

  createIdTable(): Promise<any> {
    // We use a version of sqlite which doesn't support foreign keys so id is
    // an integer referenced by the metric tables
    return this.run(`CREATE TABLE IF NOT EXISTS metricIds (
      id INTEGER PRIMARY KEY ASC,
      descr TEXT,
      maxAge INTEGER
    );`, []);
  }

  createMetricTable(id: string, dataType: string) {
    const table = id;
    let sqlType = 'TEXT';

    switch (dataType) {
      case 'number':
        sqlType = 'REAL';
        break;
      case 'boolean':
        sqlType = 'INTEGER';
        break;
    }

    return this.run(`CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER,
      date DATE,
      value ${sqlType}
    );`, []);
  }

  async loadKnownMetrics(): Promise<void> {
    const rows = await this.all('SELECT id, descr, maxAge FROM metricIds');
    for (const row of rows) {
      this.idToDescr[row.id] = JSON.parse(row.descr);
      this.idToDescr[row.id].maxAge = row.maxAge;
      this.descrToId[row.descr] = row.id;
    }
  }

  propertyDescr(thingId: string, propId: string): {type: string, thing: string, property: string} {
    return {
      type: 'property',
      thing: thingId,
      property: propId,
    };
  }

  actionDescr(thingId: string, actionId: string): {type: string, thing: string, action: string} {
    return {
      type: 'action',
      thing: thingId,
      action: actionId,
    };
  }

  eventDescr(thingId: string, eventId: string): {type: string, thing: string, event: string} {
    return {
      type: 'event',
      thing: thingId,
      event: eventId,
    };
  }

  /**
   * @param {Object} rawDescr
   * @param {number} maxAge
   */
  async registerMetric(rawDescr: any, maxAge: number): Promise<number|null> {
    const descr = JSON.stringify(rawDescr);
    if (this.descrToId.hasOwnProperty(descr)) {
      return null;
    }
    const result = await this.run(
      'INSERT INTO metricIds (descr, maxAge) VALUES (?, ?)',
      [descr, maxAge]
    );
    const id = result.lastID;
    this.idToDescr[id] = Object.assign({maxAge}, rawDescr);
    this.descrToId[descr] = id;
    return id;
  }

  /**
   * @param {Object} rawDescr
   * @param {any} rawValue
   * @param {Date} date
   */
  async insertMetric(rawDescr: any, rawValue: any, date: Date): Promise<void> {
    const descr = JSON.stringify(rawDescr);
    if (!this.descrToId.hasOwnProperty(descr)) {
      return;
    }
    const id = this.descrToId[descr];

    let table = METRICS_OTHER;
    let value = rawValue;

    switch (typeof rawValue) {
      case 'boolean':
        table = METRICS_BOOLEAN;
        break;
      case 'number':
        table = METRICS_NUMBER;
        break;
      default:
        value = JSON.stringify(rawValue);
        break;
    }

    await this.run(
      `INSERT INTO ${table} (id, date, value) VALUES (?, ?, ?)`,
      [id, date, value]
    );
  }

  /**
   * Remove a metric with all its associated data
   * @param {Object} rawDescr
   */
  async unregisterMetric(rawDescr: any): Promise<void> {
    const descr = JSON.stringify(rawDescr);
    const id = this.descrToId[descr];
    await Promise.all([
      'metricIds',
      METRICS_NUMBER,
      METRICS_BOOLEAN,
      METRICS_OTHER,
    ].map((table) => {
      return this.run(`DELETE FROM ${table} WHERE id = ?`,
                      [id]);
    }));
    delete this.descrToId[descr];
    delete this.idToDescr[id];
  }

  onPropertyChanged(property: any): void {
    const thingId = property.device.id;
    const descr = this.propertyDescr(thingId, property.name);
    this.insertMetric(descr, property.value, new Date());
  }

  buildQuery(table: string, id: number|null, start: number|null, end: number|null,
             limit: number|null): {query: string, params: number[]} {
    const conditions = [];
    const params = [];
    if (typeof id === 'number') {
      conditions.push('id = ?');
      params.push(id);
    }
    if (start || start === 0) {
      conditions.push('date > ?');
      params.push(start);
    }
    if (end) {
      conditions.push('date < ?');
      params.push(end);
    }

    let query = `SELECT id, value, date FROM ${table}`;
    if (conditions.length > 0) {
      query += ' WHERE ';
      query += conditions.join(' AND ');
    }
    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    return {
      query,
      params,
    };
  }

  async loadMetrics(out: any, table: string, transformer: ((arg: any) => any)|null, id: number|null,
                    start: number|null, end: number|null): Promise<void> {
    const {query, params} = this.buildQuery(table, id, start, end, null);
    const rows = await this.all(query, params);

    for (const row of rows) {
      const descr = this.idToDescr[row.id];
      if (!descr) {
        console.error('Failed to load row:', row);
        continue;
      }
      if (!out.hasOwnProperty(descr.thing)) {
        out[descr.thing] = {};
      }
      if (!out[descr.thing].hasOwnProperty(descr.property)) {
        out[descr.thing][descr.property] = [];
      }
      const value = transformer ? transformer(row.value) : row.value;
      out[descr.thing][descr.property].push({
        value: value,
        date: row.date,
      });
    }
  }

  async getAll(start: number|null, end: number|null): Promise<any> {
    const out = {};
    await this.loadMetrics(out, METRICS_NUMBER, null, null, start, end);
    await this.loadMetrics(out, METRICS_BOOLEAN, (value) => !!value, null,
                           start, end);
    await this.loadMetrics(out, METRICS_OTHER, (value) => JSON.parse(value),
                           null, start, end);
    return out;
  }

  async get(thingId: string, start: number|null, end: number|null): Promise<any> {
    const all = await this.getAll(start, end);
    return all[thingId];
  }

  async getProperty(thingId: string, propertyName: string, start: number|null, end: number|null):
  Promise<any> {
    const descr = JSON.stringify(this.propertyDescr(thingId, propertyName));
    const out: any = {};
    const id = this.descrToId[descr];
    // TODO determine property type to only do one of these
    await this.loadMetrics(out, METRICS_NUMBER, null, id, start, end);
    await this.loadMetrics(out, METRICS_BOOLEAN, (value) => !!value, id, start,
                           end);
    await this.loadMetrics(out, METRICS_OTHER, (value) => JSON.parse(value),
                           id, start, end);
    return out[thingId][propertyName];
  }

  async getSchema(): Promise<any> {
    await this.loadKnownMetrics();
    const schema = [];
    for (const id in this.idToDescr) {
      const descr = this.idToDescr[id];
      schema.push({
        id,
        thing: descr.thing,
        property: descr.property,
      });
    }
    return schema;
  }

  async streamMetrics(callback: (metrics: any[]) => void, table: string,
                      transformer: ((arg: any) => any)|null, id: number|null, start: number|null,
                      end: number|null): Promise<void> {
    const MAX_ROWS = 10000;
    start = start ?? 0;
    end = end ?? Date.now();

    let queryCompleted = false;
    while (!queryCompleted) {
      const {query, params} = this.buildQuery(table, id, start, end, MAX_ROWS);
      const rows = await this.all(query, params);
      if (rows.length < MAX_ROWS) {
        queryCompleted = true;
      }
      callback(rows.map((row: any) => {
        const value = transformer ? transformer(row.value) : row.value;
        return {
          id: row.id,
          value: value,
          date: row.date,
        };
      }));
      if (!queryCompleted) {
        const lastRow = rows[rows.length - 1];
        start = lastRow.date;
        if (start! >= end) {
          queryCompleted = true;
        }
      }
    }
  }

  async streamAll(callback: (metrics: any[]) => void, start: number|null, end: number|null):
  Promise<void> {
    // Stream all three in parallel, which should look cool
    await Promise.all([
      this.streamMetrics(callback, METRICS_NUMBER, null, null, start, end),
      this.streamMetrics(callback, METRICS_BOOLEAN,
                         (value: any) => !!value, null, start, end),
      this.streamMetrics(callback, METRICS_OTHER,
                         (value: any) => JSON.parse(value), null, start, end),
    ]);
  }

  async clearOldMetrics(): Promise<any> {
    await this.loadKnownMetrics();
    for (const id in this.idToDescr) {
      const descr = this.idToDescr[id];
      if (descr.maxAge <= 0) {
        continue;
      }
      const date = new Date(Date.now() - descr.maxAge);
      await Promise.all([
        METRICS_NUMBER,
        METRICS_BOOLEAN,
        METRICS_OTHER,
      ].map((table) => {
        return this.run(`DELETE FROM ${table} WHERE id = ? AND date < ?`,
                        [id, date]);
      }));
    }
  }

  all(sql: string, ...params: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      params.push(function(err: any, rows: any[]) {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      });

      try {
        this.db!.all(sql, ...params);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Run a SQL statement
   * @param {String} sql
   * @param {Array<any>} values
   * @return {Promise<Object>} promise resolved to `this` of statement result
   */
  run(sql: string, values: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        this.db!.run(sql, values, function(err) {
          if (err) {
            reject(err);
            return;
          }
          // node-sqlite puts results on "this" so avoid arrrow fn.
          resolve(this);
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}

const logs = new Logs();
export default logs;
