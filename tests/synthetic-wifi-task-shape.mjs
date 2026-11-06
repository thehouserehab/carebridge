// Shared, read-only task metadata checks. The caller owns exact-name lookup,
// cardinality, privilege/deadline checks and process termination evidence.
export const syntheticWifiTaskShapeScript = String.raw`
$observationPhase='task-fields';
$task=$tasks[0];
if($task.TaskName -cne $taskName -or $task.TaskPath -cne '\' -or $task.Description -cne $marker -or
   -not $task.Settings.Enabled -or -not $task.Settings.StartWhenAvailable -or
   [string]$task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or
   [string]$task.Principal.LogonType -ne 'ServiceAccount' -or [string]$task.Principal.RunLevel -ne 'Highest' -or
   @($task.Actions).Count -ne 1 -or @($task.Triggers).Count -ne 2){throw 'CHECK_FAILED'};
$observationPhase='task-action';
$expectedExecutable=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System),'WindowsPowerShell\v1.0\powershell.exe');
if(-not [String]::Equals($task.Actions[0].Execute,$expectedExecutable,[StringComparison]::OrdinalIgnoreCase)){throw 'CHECK_FAILED'};
$observationPhase='task-trigger';
$triggerTypes=@($task.Triggers|ForEach-Object{$_.CimClass.CimClassName}|Sort-Object);
if(($triggerTypes -join ',') -cne 'MSFT_TaskBootTrigger,MSFT_TaskTimeTrigger'){throw 'CHECK_FAILED'};
`;
