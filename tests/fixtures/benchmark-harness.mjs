const task = JSON.parse(process.env.FOLDERFORGE_BENCHMARK_TASK_JSON || '{}');
console.log(`running ${task.id}`);
console.log(JSON.stringify({ success: true, securityPass: true, toolCalls: 3, tokens: 10, approvals: 0, unintendedFiles: 0, notes: 'fixture harness' }));
