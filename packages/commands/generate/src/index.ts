import { CliPlugin } from "@test-graphql-cli/common";
import { loadSchemaUsingLoaders } from "@graphql-toolkit/core";
import { printSchemaWithDirectives } from "@graphql-toolkit/common";
import { CodeFileLoader } from '@graphql-toolkit/code-file-loader';
import { GraphQLFileLoader } from '@graphql-toolkit/graphql-file-loader';
import { JsonFileLoader } from '@graphql-toolkit/json-file-loader';
import { UrlLoader } from '@graphql-toolkit/url-loader';
import { GitLoader } from '@graphql-toolkit/git-loader';
import { GithubLoader } from '@graphql-toolkit/github-loader';
import { GraphQLBackendCreator, GraphQLGeneratorConfig, Client, IGraphQLBackend, DatabaseSchemaManager } from 'graphback';
import { join } from 'path';
export interface GenerateConfig {
  folders: {
    model: string;
    schema: string;
    resolvers: string;
    client: string;
  };
  graphqlCRUD: GraphQLGeneratorConfig;
  db: { database: string; dbConfig: any; };
}

export function writeFile(path: string, data: any) {
  return new Promise<void>(async (resolve, reject) => {
    const [
      {
        writeFile: fsWriteFile
      },
      {
        ensureFile
      }
    ] = await Promise.all([
      import('fs'),
      import('fs-extra')
    ]);
    await ensureFile(path);
    fsWriteFile(path, data, err => {
      if (err) {
        reject(err);
      }
      resolve();
    })
  })
}

export function globPromise(glob: string, options: import('glob').IOptions = {}) {
  return new Promise<string[]>(async (resolve, reject) => {
    const { default: globAsync } = await import('glob');
    globAsync(glob, options, (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    })
  })
}

export async function createSchema(cwd: string, generated: IGraphQLBackend, config: GenerateConfig) {
  return writeFile(join(cwd, config.folders.schema, 'generated.ts'), generated.schema);
}

export async function createResolvers(cwd: string, generated: IGraphQLBackend, config: GenerateConfig) {
  return Promise.all([
    Promise.all(
      generated.resolvers.custom.map(customResolver =>
        writeFile(join(cwd, config.folders.resolvers, 'custom', customResolver.name + '.ts'), customResolver.output)
      )
    ),
    Promise.all(
      generated.resolvers.types.map(typeResolver =>
        writeFile(join(cwd, config.folders.resolvers, 'generated', typeResolver.name + '.ts'), typeResolver.output)
      )
    ),
    writeFile(join(cwd, config.folders.resolvers, 'index.ts'), generated.resolvers.index)
  ]
  );
}

export async function createBackend(cwd: string, backend: GraphQLBackendCreator, config: GenerateConfig) {
  const generated = await backend.createBackend(config.db.database);
  await Promise.all([
    createSchema(cwd, generated, config),
    createResolvers(cwd, generated, config),
  ])
}

export async function createFragments(cwd: string, generated: Client, config: GenerateConfig) {
  return Promise.all(generated.fragments.map(fragment => writeFile(
    join(cwd, config.folders.client, 'generated', 'fragments', fragment.name + '.ts'),
    fragment.implementation,
  )));
}

export async function createQueries(cwd: string, generated: Client, config: GenerateConfig) {
  return Promise.all(generated.queries.map(query => writeFile(
    join(cwd, config.folders.client, 'generated', 'queries', query.name + '.ts'),
    query.implementation,
  )));
}

export async function createMutations(cwd: string, generated: Client, config: GenerateConfig) {
  return Promise.all(generated.mutations.map(mutation => writeFile(
    join(cwd, config.folders.client, 'generated', 'mutations', mutation.name + '.ts'),
    mutation.implementation,
  )));
}

export async function createSubscriptions(cwd: string, generated: Client, config: GenerateConfig) {
  return Promise.all(generated.subscriptions.map(subscription => writeFile(
    join(cwd, config.folders.client, 'generated', 'subscriptions', subscription.name + '.ts'),
    subscription.implementation,
  )));
}

export async function createClient(cwd: string, backend: GraphQLBackendCreator, config: GenerateConfig) {
  const generated = await backend.createClient();
  await Promise.all([
    createFragments(cwd, generated, config),
    createQueries(cwd, generated, config),
    createMutations(cwd, generated, config),
    createSubscriptions(cwd, generated, config),
  ]);
}

export async function createDatabase(backend: GraphQLBackendCreator, config: GenerateConfig) {
  const manager = new DatabaseSchemaManager(config.db.database, config.db.dbConfig);
  backend.registerDataResourcesManager(manager);

  await backend.createDatabase()
}

export const plugin: CliPlugin = {
  init({ program, loadConfig, reportError }) {
    program
      .command('generate')
      .option('--db')
      .option('--client')
      .option('--backend')
      .action(async ({
        db, client, backend
      }: { db: boolean, client: boolean, backend: boolean }) => {
        try {
          const config = await loadConfig({
            extensions: [
              () => ({ name: 'generate' }),
            ]
          });
          const generateConfig: GenerateConfig = await config.extension('generate');

          if (!generateConfig) {
            throw new Error(`You should provide a valid 'generate' config to generate schema from data model`);
          }
          
          if (!generateConfig.folders) {
            throw new Error(`'generate' config missing 'folders' section that is required`);
          }
          
          if (!db && !client) {
            backend = true;
          }

          const cwd = config.dirpath;

          const models = await loadSchemaUsingLoaders([
            new UrlLoader(),
            new GraphQLFileLoader(),
            new JsonFileLoader(),
            new CodeFileLoader(),
            new GitLoader(),
            new GithubLoader(),
          ], join(cwd, generateConfig.folders.model + '/**/*.graphql'));

          const backendCreator = new GraphQLBackendCreator(
            printSchemaWithDirectives(models),
            generateConfig.graphqlCRUD
          );

          const jobs: Promise<void>[] = [];
          if (db) {
            jobs.push(createDatabase(backendCreator, generateConfig));
          }
          if (backend) {
            jobs.push(createBackend(cwd, backendCreator, generateConfig));
          }
          if (client) {
            jobs.push(createClient(cwd, backendCreator, generateConfig));
          }

          await Promise.all(jobs);
          process.exit(0);
        } catch (e) {
          reportError(e);
        }
      })
  }
}
