import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

let pool: Pool | undefined;

function config(): PoolOptions {
  const host = process.env["MYSQL_HOST"];
  const database = process.env["MYSQL_DATABASE"];
  const user = process.env["MYSQL_USER"];
  const password = process.env["MYSQL_PASSWORD"];
  const rawPort = process.env["MYSQL_PORT"];
  if (!host || !database || !user || password === undefined) {
    throw new Error("MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER and MYSQL_PASSWORD are required");
  }
  const port = rawPort ? Number(rawPort) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MYSQL_PORT must be a valid TCP port");
  }
  return { host, port, database, user, password, waitForConnections: true, connectionLimit: 10, multipleStatements: true };
}

export function getMysqlPool(): Pool {
  pool ??= mysql.createPool(config());
  return pool;
}

export async function checkMysqlConnection(): Promise<void> {
  await getMysqlPool().query("SELECT 1");
}