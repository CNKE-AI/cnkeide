// Demo entry: import formatTime util and print the formatted result
import { formatTime } from './utils/format';

const timestamp = Date.now();
const formatted = formatTime(timestamp);

console.log('Current timestamp: ' + timestamp);
console.log('Formatted time   : ' + formatted);
