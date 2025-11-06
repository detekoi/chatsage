// In a utility file, e.g., src/lib/timeUtils.js
const getCurrentTime = (timezoneOrOptions = 'UTC') => {
    // Handle both string and object parameters
    const timezone = typeof timezoneOrOptions === 'string' 
        ? timezoneOrOptions 
        : timezoneOrOptions.timezone || 'UTC';
    try {
      const now = new Date();
      // Intl.DateTimeFormat is robust for timezone handling
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false, // Use 24-hour format for clarity
        hourCycle: 'h23', // Ensure hours stay within 00-23
        timeZoneName: 'short', // e.g., UTC, PST, BST
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const formattedTime = formatter.format(now);
      console.log(`getCurrentTime: Returning time for ${timezone}: ${formattedTime}`);
      return { currentTime: formattedTime };
    } catch (error) {
       console.error(`Error getting time for timezone ${timezone}:`, error);
       // Handle invalid timezone strings gracefully
       if (error instanceof RangeError) {
         return { error: `Invalid timezone specified: ${timezone}` };
       }
       return { error: 'Failed to retrieve current time.' };
    }
  };
  
  export { getCurrentTime };

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

