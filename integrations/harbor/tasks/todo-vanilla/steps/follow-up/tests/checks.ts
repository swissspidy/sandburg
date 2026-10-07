// The app-gen eval's checks for "todo"'s follow-up (evals/app-gen/suite.ts in Sandburg's repository).
const home = process.env.SANDBURG_HOME;
if (!home) throw new Error('SANDBURG_HOME is not set (the Sandburg environment sets it)');
const { SUITE } = await import(`${home}/evals/app-gen/suite.ts`);
export default SUITE.find((t) => t.id === 'todo').followUp.checks;
