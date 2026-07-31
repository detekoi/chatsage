// Tool definitions for OpenAI Responses API

export const standardAnswerTools = [
    {
        type: "function",
        name: "getCurrentTime",
        description: "Get the current date and time for a specific, validated IANA timezone string. If a user mentions a location (e.g. 'San Diego'), first use 'get_iana_timezone_for_location_tool' to resolve it to an IANA timezone, then call this function with that IANA string. Defaults to UTC if no timezone is provided.",
        parameters: {
            type: "object",
            properties: {
                timezone: {
                    // Strict mode requires every property in `required`; optionality
                    // is expressed via the null union (the handler defaults to UTC).
                    type: ["string", "null"],
                    description: "The IANA timezone name (e.g., 'America/Los_Angeles', 'Europe/Paris') if a specific location's time is needed, or null for UTC."
                }
            },
            required: ["timezone"],
            additionalProperties: false
        },
        strict: true
    },
    {
        type: "function",
        name: "get_iana_timezone_for_location_tool",
        description: "Resolves a human-readable location name (city, region) into its standard IANA timezone string. This should be called BEFORE calling 'getCurrentTime' if a user specifies a location.",
        parameters: {
            type: "object",
            properties: {
                location_name: {
                    type: "string",
                    description: "The city or location name mentioned by the user (e.g., 'San Diego', 'Paris')."
                }
            },
            required: ["location_name"],
            additionalProperties: false
        },
        strict: true
    }
];

// OpenAI built-in web search tool configuration
export const searchTool = [{ type: 'web_search' }];
